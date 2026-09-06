import { auth, db } from "./firebase.js";

import {
  onAuthStateChanged,
  signInAnonymously
} from "firebase/auth";

import {
  addDoc,
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc
} from "firebase/firestore";

function getOrCreateRaidId() {
  const url = new URL(window.location.href);
  let raidId = url.searchParams.get("raid");

  if (!raidId) {
    raidId = crypto.randomUUID();
    url.searchParams.set("raid", raidId);
    window.history.replaceState({}, "", url);
  }

  return raidId;
}

const raidId = getOrCreateRaidId();
const raidDocument = doc(db, "raids", raidId);

let currentUser = null;
let participantName = localStorage.getItem("wizard101-participant-name") || "";
let firebaseReady = false;
let applyingRemoteState = false;
let saveTimer = null;
let unsubscribeRaid = null;
let unsubscribeMessages = null;
let unsubscribeParticipants = null;
let presenceInterval = null;
let latestMessages = [];
let allParticipants = [];
let liveStatusTimer = null;
let changeVersion = 0;
let hasPendingPlannerChanges = false;
let pendingSaveGeneration = 0;
let saveStatusText = "Connecting…";
let saveStatusIsLive = false;

function showWelcomeDialog() {
  return new Promise((resolve) => {
    const dialog = document.createElement("div");
    dialog.className = "welcome-backdrop";
    dialog.innerHTML = `
      <form class="welcome-dialog">
        <div class="welcome-mark">W101</div>
        <div class="eyebrow">SHARED RAID ROOM</div>
        <h2>Join the planning table</h2>
        <p>Choose the name your teammates will see in chat and in the connected-player list.</p>
        <label for="welcome-name">Display name</label>
        <input id="welcome-name" maxlength="30" autocomplete="nickname" placeholder="Your wizard name" required />
        <button class="primary" type="submit">Join raid</button>
      </form>`;
    const form = dialog.querySelector("form");
    const input = dialog.querySelector("input");
    input.value = participantName;
    document.body.appendChild(dialog);
    requestAnimationFrame(() => input.focus());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim().slice(0, 30);
      if (!name) return;
      participantName = name;
      localStorage.setItem("wizard101-participant-name", participantName);
      dialog.remove();
      resolve();
    });
  });
}

async function startFirebase() {
  await showWelcomeDialog();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      try {
        await signInAnonymously(auth);
      } catch (error) {
        console.error("Anonymous login failed:", error);
        window.alert("Could not connect to the shared planner.");
      }

      return;
    }

    currentUser = user;
    firebaseReady = true;

    subscribeToRaid();
    subscribeToMessages();
    startPresence();
  });
}

const schools = ["Storm", "Fire", "Ice", "Life", "Death", "Myth", "Balance", "Shadow"];
const cardTypes = ["Attack", "Blade", "Trap", "Shield", "Heal", "Utility"];

const schoolPalette = {
  Storm: { accent: "#7f5af0", glow: "#f4d35e", panel: "#241b45" },
  Fire: { accent: "#ff4d4d", glow: "#f7d154", panel: "#6c1d1d" },
  Ice: { accent: "#bfe8ff", glow: "#ffffff", panel: "#3c6c8d" },
  Life: { accent: "#9fe79a", glow: "#3ca86d", panel: "#17412e" },
  Death: { accent: "#0d0d0d", glow: "#f5f5f5", panel: "#2a2a2a" },
  Myth: { accent: "#f7d75b", glow: "#4a7ed8", panel: "#1d2a4a" },
  Balance: { accent: "#d9b98a", glow: "#7e2d2d", panel: "#432422" },
  Shadow: { accent: "#8b5cf6", glow: "#d8b4fe", panel: "#1d102d" }
};

function getSchoolLogoSvg(school) {
  const icons = {
    Fire: "/pictures/icons/Fire school.png",
    Death: "/pictures/icons/Death school.png",
    Balance: "/pictures/icons/Balance school.png",
    Ice: "/pictures/icons/Ice school.png",
    Storm: "/pictures/icons/Storm school.png",
    Life: "/pictures/icons/Life school.png",
    Myth: "/pictures/icons/Myth school.png"
  };

  return icons[school] || icons.Balance;
}

function getSchoolGradient(school) {
  const palette = schoolPalette[school] || schoolPalette.Balance;
  return `linear-gradient(135deg, ${palette.accent} 0%, ${palette.glow} 100%)`;
}

function getSchoolBadgeMarkup(school) {
  return `
    <span class="school-badge" aria-label="${school} school">
      <img src="${getSchoolLogoSvg(school)}" alt="${school}" />
    </span>
  `;
}

function shouldShowSchoolBadge(imageUrl) {
  return typeof imageUrl === "string" && imageUrl.startsWith("data:image/svg+xml");
}

function buildLocalSpellImageUrl(school, spellName) {
  const normalizedSchool = String(school || "").trim();
  const normalizedSpellName = String(spellName || "").trim();

  if (!normalizedSchool || !normalizedSpellName) return "";

  const folderNames = {
    Fire: "Fire  school",
    Balance: "Balance school",
    Death: "Death school",
    Ice: "Ice school",
    Life: "Life school",
    Myth: "Myth school",
    Storm: "Storm school",
    Shadow: "Shadow school"
  };

  const folderName = folderNames[normalizedSchool];
  if (!folderName) return "";

  return `/pictures/${encodeURIComponent(folderName)}/${encodeURIComponent(normalizedSpellName)}.png`;
}

function makeSpellImage(card) {
  const palette = schoolPalette[card.school];
  const title = card.name.replace(/&/g, "&amp;");
  const type = card.type;
  const pips = card.pips ? `Pips ${card.pips}` : "Spell";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 136">
      <defs>
        <linearGradient id="grad" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${palette.glow}"/>
          <stop offset="100%" stop-color="${palette.panel}"/>
        </linearGradient>
      </defs>
      <rect width="240" height="136" rx="16" fill="url(#grad)"/>
      <rect x="12" y="12" width="216" height="112" rx="12" fill="rgba(255,255,255,0.07)"/>
      <text x="20" y="74" fill="#ffffff" font-size="18" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${title}</text>
      <text x="20" y="96" fill="#dfeafc" font-size="12" font-family="Segoe UI, Arial, sans-serif">${type}</text>
      <text x="165" y="96" fill="${palette.accent}" font-size="12" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${pips}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function getFallbackCardImage(card) {
  return makeSpellImage(card);
}

function describeImageFailure(card, sourceUrl) {
  const safeName = card?.name || "Unknown spell";
  return `Image could not be loaded for "${safeName}" because the remote source was missing or returned 404: ${sourceUrl}`;
}

function logImageFailure(imgEl, card, sourceUrl) {
  const reason = describeImageFailure(card, sourceUrl);
  console.error(reason);
}

function handleImageFailure(event, card) {
  const imgEl = event.currentTarget;
  const sourceUrl = imgEl.dataset.originalSrc || imgEl.getAttribute("src") || "unknown source";
  const fallbackCard = {
    name: card?.name || imgEl.dataset.cardName || "Unknown spell",
    school: card?.school || imgEl.dataset.cardSchool || "Balance",
    type: card?.type || imgEl.dataset.cardType || "Utility",
    pips: Number(card?.pips ?? imgEl.dataset.cardPips ?? 0)
  };

  imgEl.src = getFallbackCardImage(fallbackCard);
  logImageFailure(imgEl, fallbackCard, sourceUrl);
}

const spellImageMap = {};

const offlineSchoolSpellNames = {
  Fire: [
    "Fire Cat",
    "Fire Cat A",
    "Fire Cat C",
    "Fire Elf",
    "Fire Elf A",
    "Fire Elf C",
    "Glacial Shield",
    "Sunbird",
    "Sunbird B",
    "Sunbird C",
    "Fire Trap",
    "Glacial Golem",
    "Glacial Golem B",
    "Meteor Strike",
    "Meteor Strike B",
    "Immolate",
    "Immolate B",
    "Wyldfire",
    "Phoenix",
    "Phoenix B",
    "Phoenix C",
    "Naphtha Scarab",
    "Helephant",
    "Helephant B",
    "Helephant C",
    "Inferno Salamander",
    "Inferno Salamander B",
    "Meltdown",
    "Backfire",
    "Fire Dragon",
    "Fire Dragon B",
    "Efreet",
    "Efreet B",
    "Jinn's Reversal",
    "Rain of Fire",
    "Rain of Fire B",
    "Caldera Jinn",
    "Sun Serpent",
    "Sun Serpent B",
    "King Artorius (Fire)",
    "King Artorius (Fire) B",
    "Oni's Forge",
    "Infernal Oni",
    "Fire Shield",
    "Fire Weakness",
    "Tranquilize",
    "Quench",
    "Take Power",
    "Mega Tranquilize",
    "Mass Fire Prism",
    "Firespear",
    "Combustion",
    "Link",
    "A-Baahh-Calypse",
    "Brimstone Revenant",
    "Brimstone Revenant B",
    "Burning Rampage",
    "Burning Rampage B",
    "Fires of Mars",
    "Fires of Mars B",
    "Hephaestus",
    "Jackall & Hound",
    "Jackall & Hound B",
    "Krampus",
    "Krampus B",
    "Nautilus Unleashed",
    "Nautilus Unleashed B",
    "Whitehart Fire",
    "Whitehart Fire B",
    "Fireblade",
    "Fire Prism",
    "Link",
    "Steal Charm",
    "Heck Hound",
    "Heck Hound B",
    "Choke",
    "Fire Elemental",
    "Scald",
    "Fuel",
    "Smoke Screen",
    "Power Link",
    "Detonate",
    "Backdraft",
    "Sir Lamorak",
    "Fire from Above",
    "Fire from Above B",
    "Raging Bull",
    "Raging Bull B",
    "Scorching Scimitars",
    "Scorching Scimitars B",
    "Scion of Fire",
    "Scion of Fire B",
    "S'more Machine",
    "S'more Machine B",
    "Blast Off!",
    "Blast Off! B",
    "Glimpse of Infinity",
    "Glimpse of Infinity A",
    "Phantasmania!",
    "Phantasmania! B",
    "Ammut",
    "Ammut B",
    "The Chariot",
    "The Chariot B",
    "Mist Trap",
    "Inferno Blade",
    "Inferno Attenuate",
    "Caldera Trap",
    "Wild Amplify",
    "Wild Blade",
    "Ember Attenuate",
    "Ember Blade",
    "Dune Trap"
  ],
  Balance: [
    "Scarab",
    "Scarab A",
    "Scarab C",
    "Scorpion",
    "Scorpion B",
    "Scorpion C",
    "Weakness",
    "Locust Swarm",
    "Locust Swarm B",
    "Locust Swarm C",
    "Sandstorm",
    "Elemental Golem",
    "Gearhead Destroyer",
    "Balance of Power",
    "Spectral Blast",
    "Spectral Blast B",
    "Spectral Blast D",
    "Donate Power",
    "Blade Dilution",
    "Trap Dilution",
    "Iron Curse",
    "Iron Curse B",
    "Iron Curse C",
    "Hydra",
    "Hydra B",
    "Hydra D",
    "Obsidian Colossus",
    "Obsidian Colossus B",
    "Righting the Scales",
    "Eye of Vigilance",
    "Power Nova",
    "Power Nova B",
    "Ra",
    "Ra B",
    "Jinn's Fortune",
    "Chimera",
    "Chimera B",
    "Duststorm Jinn",
    "Courageous Charge",
    "Spinning Scythe",
    "Sabertooth",
    "Sabertooth B",
    "King Artorius (Balance)",
    "King Artorius (Balance) B",
    "Oni's Shadow",
    "Tribunal Oni",
    "Elemental Trap",
    "Elemental Weakness",
    "Spirit Weakness",
    "Spirit Trap",
    "Reshuffle",
    "Unbalance",
    "Elemental Blade",
    "Spirit Blade",
    "Purloin Health",
    "Elemental Spear",
    "Spirit Spear",
    "Counterforce",
    "Precision",
    "Brave Sir Badger",
    "Brave Sir Badger B",
    "Dyvim's Resurgence",
    "Dyvim's Resurgence B",
    "Loremaster",
    "Loremaster A",
    "Loremaster B",
    "Ninja Piglets",
    "Ninja Piglets B",
    "Ninja Piglets C",
    "Pops' Knuckles",
    "Pops' Knuckles B",
    "Samoorai",
    "Savage Paw",
    "Spiritual Tribunal",
    "Spiritual Tribunal B",
    "Spiritual Tribunal C",
    "Steal Pip",
    "Terminus' Strike",
    "Terminus' Strike B",
    "Elemental Shield",
    "Spirit Shield",
    "Balanceblade",
    "Black Mantle",
    "Mander Minion",
    "Helping Hands",
    "Hex",
    "Judgement",
    "Judgement B",
    "Bladestorm",
    "Elemental Defuse",
    "Spirit Defuse",
    "Spectral Minion",
    "Availing Hands",
    "Mana Burn",
    "Supernova",
    "Nerys",
    "Gaze of Fate",
    "Gaze of Fate B",
    "Nested Fury",
    "Nested Fury B",
    "Sand Wurm",
    "Sand Wurm B",
    "Scion of Balance",
    "Scion of Balance B",
    "Mockenspiel",
    "Mockenspiel B",
    "Old One's Endgame",
    "Old One's Endgame B",
    "Scales of Destiny",
    "Scales of Destiny B",
    "Rainbow Serpent",
    "Rainbow Serpent B",
    "Chameleon Clash",
    "Chameleon Clash B",
    "Wheel of Fortune",
    "Wheel of Fortune B",
    "Heat Trap",
    "Shade Trap",
    "Dust Blade",
    "Dust Amplify",
    "Story Trap",
    "Oasis Amplify",
    "Oasis Blade",
    "Drought Attenuate",
    "Drought Blade"
  ],
  Death: [
    "Dark Sprite",
    "Ghoul",
    "Dream Shield",
    "Banshee",
    "Vampire",
    "Dream Golem",
    "Feint",
    "Skeletal Pirate",
    "Doom and Gloom",
    "Deadzone",
    "Crimson Phantom",
    "Wraith",
    "Monster Mash",
    "Putrefaction",
    "Contagion",
    "Scarecrow",
    "Skeletal Dragon",
    "Jinn's Larceny",
    "Dr. Von's Monster",
    "Macabre Jinn",
    "Avenging Fossil",
    "King Artorius (Death)",
    "Oni's Morbidity",
    "Doom Oni",
    "Infection",
    "Threefold Fever",
    "Death Shield",
    "Death Weakness",
    "Pacify",
    "Strangle",
    "Steal Health",
    "Mega Pacify",
    "Mass Death Prism",
    "Deathspear",
    "Age of Reckoning",
    "Death Trap",
    "Deer Knight",
    "Headless Horseman",
    "Jacques Scratches!",
    "Kiiii-Yaaaa!",
    "Lord of Night",
    "Monk of Mourning",
    "Pluto's Peril",
    "Ship of Fools",
    "Deathblade",
    "Death Prism",
    "Sacrifice",
    "Curse",
    "Poison",
    "Beguile",
    "Animate",
    "Plague",
    "Dark Tribute",
    "Empower",
    "Virulent Plague",
    "Mass Infection",
    "Bad Juju",
    "Malduit",
    "Avenging Fossil",
    "Call of Khrulhu",
    "Winged Sorrow",
    "Qismah's Curse",
    "Scion of Death",
    "Snack Attack",
    "Grim Reader",
    "Gravestorm",
    "Wobbegong Frenzy",
    "Anubis",
    "Mortality",
    "Ash Trap",
    "Permafrost Trap",
    "Drowned Blade",
    "Drowned Amplify",
    "Extinction Trap",
    "Ghost Amplify",
    "Ghost Blade",
    "Tomb Blade"
  ],
  Ice: [
    "Frost Beetle",
    "Snow Serpent",
    "Volcanic Shield",
    "Evil Snowman",
    "Tower Shield",
    "Volcanic Golem",
    "Ice Wyvern",
    "Blizzard",
    "Balefrost",
    "Blight Hound",
    "Thieving Dragon",
    "Colossus",
    "Frostfeather",
    "Wall of Blades",
    "Glacial Fortress",
    "Frost Giant",
    "Snow Angel",
    "Jinn's Vexation",
    "Woolly Mammoth",
    "Iceburn Jinn",
    "Impair",
    "Lord of Winter",
    "King Artorius (Ice)",
    "Oni's Destruction",
    "Everwinter Oni",
    "Stun Block",
    "Snow Shield",
    "Ice Weakness",
    "Distract",
    "Taunt",
    "Melt",
    "Draw Health",
    "Mega Distract",
    "Mega Taunt",
    "Mass Ice Prism",
    "Icespear",
    "Katabatic Wind",
    "Ice Trap",
    "Angry Snowpig",
    "Celestial Intervention",
    "Deermouse Trap",
    "Handsome Fomori",
    "Ice Elemental",
    "Neptune's Fury",
    "Ratstabber",
    "Reindeer Knight",
    "Winter Moon",
    "Freeze",
    "Ice Prism",
    "Ice Armor",
    "Steal Ward",
    "Frostbite",
    "Ice Guardian",
    "Legion Shield",
    "Iceblade",
    "Frost Giant",
    "Frozen Armor",
    "Snow Drift",
    "Cooldown",
    "Freddo",
    "Abominable Weaver",
    "Snowball Barrage",
    "Climaclysm",
    "Scion of Ice",
    "Shatterhorn",
    "Freeze Ray",
    "Deathly Depths",
    "Count Croakula",
    "Shu",
    "The Hierophant",
    "Burn Trap",
    "Squall Blade",
    "Squall Amplify",
    "Winter Trap",
    "Glacier Amplify",
    "Glacier Blade",
    "Blight Attenuate",
    "Blight Blade",
    "Avalanche Trap"
  ],
  Life: [
    "Imp",
    "Leprechaun",
    "Legend Shield",
    "Sprite",
    "Nature's Wrath",
    "Spirit Armor",
    "Legend Golem",
    "Seraph",
    "Satyr",
    "Hunting Wyrm",
    "Regenerate",
    "Earth Walker",
    "Centaur",
    "Sanctuary",
    "Circle of Thorns",
    "Infestation",
    "Sprite Swarm",
    "Tranquility",
    "Meditation",
    "Forest Lord",
    "Rebirth",
    "Jinn's Affliction",
    "Verdurous Jinn",
    "Gnomes!",
    "Spinysaur",
    "King Artorius (Life)",
    "Oni's Naturalism",
    "Primal Oni",
    "Life Shield",
    "Life Weakness",
    "Life Trap",
    "Calm",
    "Entangle",
    "Drain Health",
    "Mega Calm",
    "Mass Life Prism",
    "Lifespear",
    "Namaste",
    "Burrowing Bane",
    "Camp Bandit",
    "Goat Monk",
    "Luminous Weaver",
    "Phoebus' Will",
    "Pigsie",
    "Sacred Charge",
    "Ratatoskr's Spin",
    "Whiplash",
    "Minor Blessing",
    "Fairy",
    "Pixie",
    "Unicorn",
    "Life Prism",
    "Sprite Guardian",
    "Lifeblade",
    "Guidance",
    "Guiding Light",
    "Triage",
    "Dryad",
    "Brilliant Light",
    "Mass Triage",
    "Guardian Spirit",
    "Sir Bedevere",
    "Hungry Caterpillar",
    "Wings of Fate",
    "Lamassu",
    "Scion of Life",
    "Grrnadier",
    "Lord of the Jungle",
    "Starspawn",
    "Zand the Bandit",
    "Taweret",
    "The World",
    "Temper Trap",
    "Patience Trap",
    "Energy Blade",
    "Energy Attenuate",
    "Memory Trap",
    "Soul Attenuate",
    "Soul Blade",
    "Strength Blade"
  ],
  Myth: [
    "Blood Bat",
    "Troll",
    "Myth Trap",
    "Cyclops",
    "Ether Shield",
    "Ether Golem",
    "Humongofrog",
    "Time of Legend",
    "Minotaur",
    "Stone Colossus",
    "Vermin Virtuoso",
    "Earthquake",
    "Delusion",
    "Betrayal",
    "Orthrus",
    "Medusa",
    "Jinn's Defense",
    "Basilisk",
    "Phantastic Jinn",
    "Purge",
    "Celestial Calendar",
    "King Artorius (Myth)",
    "Oni's Projection",
    "Trickster Oni",
    "Myth Shield",
    "Myth Weakness",
    "Shield Minion",
    "Subdue",
    "Buff Minion",
    "Siphon Health",
    "Vaporize",
    "Mend Minion",
    "Draw Power",
    "Mega Subdue",
    "Mass Myth Prism",
    "Mythspear",
    "Saga of Heroes",
    "Gobbler",
    "Athena Battle Sight",
    "Grendel's Amends",
    "Hero of Khrysalis",
    "Keeper of the Flame",
    "Mark of Meowiarty",
    "Ninja Pigs",
    "Saturn's Reaping",
    "Splashsquatch",
    "Wreckin' Ettin",
    "Golem Minion",
    "Troll Minion",
    "Mythblade",
    "Myth Prism",
    "Cyclops Minion",
    "Pierce",
    "Cleanse Ward",
    "Stun",
    "Blinding Light",
    "Shatter",
    "Minotaur Minion",
    "Talos",
    "Shift",
    "Dimension Shift",
    "Vassanji",
    "Mystic Colossus",
    "Witch's House Call",
    "Snake Charmer",
    "Scion of Myth",
    "Tatzlewurm Terror",
    "Barbarian's Saga",
    "Improbable Gaze",
    "Drop Bear Fury",
    "Thoth",
    "The Emperor",
    "Golem Taunt",
    "Inspiration Trap",
    "History Trap",
    "Epiphany Blade",
    "Epiphany Attenuate",
    "Creation Amplify",
    "Creation Blade",
    "Finale Attenuate",
    "Finale Blade",
    "Fable Trap"
  ],
  Storm: [
    "Thunder Snake",
    "Lightning Bats",
    "Thermic Shield",
    "Storm Shark",
    "Storm Trap",
    "Thermic Golem",
    "Kraken",
    "Windstorm",
    "Darkwind",
    "Stormzilla",
    "Stormwing",
    "Triton",
    "Thunderman",
    "Reap the Whirlwind",
    "Energy Transfer",
    "Storm Lord",
    "Leviathan",
    "Jinn's Restoration",
    "Thundering Jinn",
    "Sirens",
    "Storm Owl",
    "King Artorius (Storm)",
    "Oni's Attrition",
    "Turmoil Oni",
    "Storm Shield",
    "Storm Weakness",
    "Soothe",
    "Dissipate",
    "Purloin Power",
    "Mega Soothe",
    "Mass Storm Prism",
    "Stormspear",
    "Astraphobia",
    "Beary Surprise",
    "Catalan",
    "Catch of the Day",
    "Clean Sweep",
    "Hammer of Thor",
    "Jupiter's Might",
    "Queen Calypso",
    "Revolutionary's Strike",
    "Lightning Strike",
    "Storm Prism",
    "Stormblade",
    "Disarm",
    "Water Elemental",
    "Cleanse Charm",
    "Tempest",
    "Wild Bolt",
    "Supercharge",
    "Insane Bolt",
    "Enfeeble",
    "Healing Current",
    "Mokompo",
    "Glowbug Squall",
    "Rusalka's Wrath",
    "Iron Sultan",
    "Scion of Storm",
    "Sound of Musicology",
    "Dark & Stormy",
    "Tree of Strife",
    "Bunyip's Rage",
    "Heqet",
    "The Tower",
    "Lightning Trap",
    "Hail Trap",
    "Calamity Trap",
    "Flood Amplify",
    "Flood Blade",
    "Typhoon Attenuate",
    "Typhoon Blade",
    "Tornado Blade"
  ],
  Shadow: [
    "Dark Empower",
    "Dark Fiend",
    "Dark Nova",
    "Dark Shepherd",
    "Dark Surge",
    "Dark Trikster",
    "Donate Shadow",
    "Shadow Sentinel",
    "Shadow Seraph",
    "Shadow Shrike",
    "Shadow Shield",
    "Shadow Trap",
    "Shadowblade"
  ]
};

const offlineSchoolSpellNamesTreasureCards = {
  Fire: [
    
  ],
  Balance: [
    
  ],
  Death: [
    
  ],
  Ice: [
    
  ],
  Life: [
    
  ],
  Myth: [
    
  ],
  Storm: [
    
  ]
}

const fusionRecipes = {
  Fire: [
    {
      result: "Ammut's Fury",
      requires: ["Ammut", "Fire Dragon"]
    },
    {
      result: "Ammut's Rage",
      requires: ["Ammut", "Fire Trap"]
    },
    {
      result: "Cryo Cat",
      requires: ["Fire Cat", "Ice Wyvern"]
    },
    {
      result: "Chilly Elf",
      requires: ["Fire Elf", "Thieving Dragon"]
    },
    {
      result: "Lightning Dragon",
      requires: ["Fire Dragon", "Triton"]
    },
    {
      result: "Thunderous Archer",
      requires: ["Fire Elf", "Stormzilla"]
    },
    {
      result: "Bardic Elf",
      requires: ["Fire Elf", "Stone Colossus"]
    },
    {
      result: "Living Helephant",
      requires: ["Helephant", "Forest Lord"]
    },
    {
      result: "Dragon Eternal",
      requires: ["Fire Dragon", "Spinysaur"]
    },
    {
      result: "Sun Vulture",
      requires: ["Sunbird", "Dark Sprite"]
    },
    {
      result: "Balaphant",
      requires: ["Helephant", "Scorpion"]
    },
    {
      result: "Arid Hound",
      requires: ["Heck Hound", "Locust Swarm"]
    },
    {
      result: "Night Raid",
      requires: ["Fire from Above", "Dark Fiend"]
    },
    {
      result: "Wicked Bull",
      requires: ["Raging Bull", "Dark Fiend"]
    },
    {
      result: "Shade Scimitars",
      requires: ["Scorching Scimitars", "Dark Fiend"]
    },
    {
      result: "Tenebrous Trebuchet",
      requires: ["S'more Machine", "Dark Fiend"]
    },
    {
      result: "Into Darkness",
      requires: ["Blast Off!", "Dark Fiend"]
    },
    {
      result: "Reverse-Chariot",
      requires: ["The Chariot", "Dark Fiend"]
    }
  ],
  Balance: [
    {
      result: "Chameleon Cover",
      requires: ["Chameleon Clash", "Stabilize"]
    },
    {
      result: "Chameleon Mangle",
      requires: ["Chameleon Clash", "Attenuate"]
    },
    {
      result: "Scorchpion",
      requires: ["Scorpion", "Phoenix"]
    },
    {
      result: "Frozen Swarm",
      requires: ["Locust Swarm", "Evil Snowman"]
    },
    {
      result: "Ra-Frigeration",
      requires: ["Ra", "Frost Beetle"]
    },
    {
      result: "Lightning Locusts",
      requires: ["Locust Swarm", "Stormzilla"]
    },
    {
      result: "Overloaded Gearhead",
      requires: ["Gearhead Destroyer", "Storm Shark"]
    },
    {
      result: "Mind Blown!",
      requires: ["Power Nova", "Minotaur"]
    },
    {
      result: "Foliage Farrago",
      requires: ["Sandstorm", "Seraph"]
    },
    {
      result: "Savage Sabertooth",
      requires: ["Sabertooth", "Nature's Wrath"]
    },
    {
      result: "Death Scuttler",
      requires: ["Scarab", "Banshee"]
    },
    {
      result: "Shadow of Fate",
      requires: ["Gaze of Fate", "Dark Trickster"]
    },
    {
      result: "Shadow of Fate B",
      requires: ["Gaze of Fate B", "Dark Trickster"]
    },
    {
      result: "Nested Darkness",
      requires: ["Nested Fury", "Dark Trickster"]
    },
    {
      result: "Nested Darkness B",
      requires: ["Nested Fury B", "Dark Trickster"]
    },
    {
      result: "Abyssal Wurm",
      requires: ["Sand Wurm", "Dark Trickster"]
    },
    {
      result: "Abyssal Wurm B",
      requires: ["Sand Wurm B", "Dark Trickster"]
    },
    {
      result: "Boxenspiel",
      requires: ["Mockenspiel", "Dark Trickster"]
    },
    {
      result: "Boxenspiel B",
      requires: ["Mockenspiel B", "Dark Trickster"]
    },
    {
      result: "Eldritch Checkmate",
      requires: ["Old One's Endgame", "Dark Trickster"]
    },
    {
      result: "Eldritch Checkmate B",
      requires: ["Old One's Endgame B", "Dark Trickster"]
    },
    {
      result: "Reverse-Fortune",
      requires: ["Wheel of Fortune", "Dark Trickster"]
    }
  ],
  Death: [],
  Ice: [],
  Life: [],
  Myth: [],
  Storm: []
};

function buildWikiFetchFallback(url) {
  if (typeof url !== "string") return url;
  return `https://r.jina.ai/http://${url.replace(/^https?:\/\//i, "")}`;
}

async function fetchWikiText(url) {
  const attempts = [url, buildWikiFetchFallback(url)];

  for (const candidate of attempts) {
    try {
      const response = await fetch(candidate, { cache: "force-cache" });
      if (!response.ok) {
        console.warn(`[Wiki Fetch] ${candidate} returned ${response.status}`);
        continue;
      }
      return await response.text();
    } catch (error) {
      console.warn(`[Wiki Fetch] Fetch failed for ${candidate}:`, error);
    }
  }

  throw new Error(`All fetch attempts failed for ${url}`);
}

async function resolveWikiImageUrl(spellName) {
  try {
    const filePageUrl = buildWikiSpellImageUrl(spellName);
    console.log(`[Fire Spell Image] Fetching file page for "${spellName}": ${filePageUrl}`);

    const html = await fetchWikiText(filePageUrl);
    const match = html.match(/src="([^"]+?(?:\.png|\.jpg|\.jpeg|\.gif|\.svg))"/);

    if (match && match[1]) {
      const src = match[1];
      const fullUrl = /^https?:\/\//i.test(src) ? src : `https://wiki.wizard101central.com${src}`;
      console.log(`[Fire Spell Image] Resolved "${spellName}" to: ${fullUrl}`);
      return fullUrl;
    } else {
      console.warn(`[Fire Spell Image] No image src found in file page for "${spellName}"`);
    }
  } catch (error) {
    console.warn(`[Fire Spell Image] Could not resolve image for spell "${spellName}":`, error);
  }
  return null;
}

function formatSpellDisplayName(rawName) {
  const value = String(rawName || "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!value) return "Unknown Spell";
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

let sampleCards = [];

function inferSpellType(card) {
  const text = String(card.titleText || card.realName || card.internalName || "").toLowerCase();

  if (/shield|ward|armor|aurora/.test(text)) return "Shield";
  if (/blade|strike|slash|cut/.test(text)) return "Blade";
  if (/heal|mend|restore|repair/.test(text)) return "Heal";
  if (/trap|snare|hex/.test(text)) return "Trap";
  if (/summon|boost|buff|power|prism|sleet|tide|gust|gift/.test(text)) return "Utility";
  return "Attack";
}

function parseSchoolSpellNames(rawWikiText) {
  const sectionNames = [
    "schoolspells",
    "trainerspells",
    "altsourcespells",
    "questspells",
    "shadowenhancedfusions"
  ];

  const names = [];

  sectionNames.forEach((sectionName) => {
    const pattern = new RegExp(`\\|\\s*${sectionName}\\s*=\\s*([\\s\\S]*?)(?=\\n\\|\\s*[a-zA-Z]+\\s*=|\\n}})`);
    const match = rawWikiText.match(pattern);
    if (!match) return;

    match[1]
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        const clean = entry.replace(/\s+\|\s*$/, "").trim();
        if (clean && !names.includes(clean)) names.push(clean);
      });
  });

  return names;
}

function buildOfflineCardCatalog() {
  const cards = [];

  Object.entries(offlineSchoolSpellNames).forEach(([school, spellEntries]) => {
    spellEntries.forEach((entry, index) => {
      const spell = typeof entry === "string" ? { name: entry } : entry;
      const spellName = String(spell.name || "Unknown Spell");
      const type = spell.type || inferSpellType({ titleText: spellName, realName: spellName, internalName: spellName });
      const pips = Number(spell.pips ?? 4);
      const localImage = buildLocalSpellImageUrl(school, spellName);
      const image = localImage || (school === "Fire" && fireSpellImageMap[spellName]
        ? fireSpellImageMap[spellName]
        : (spell.image || getFallbackCardImage({ name: spellName, school, type, pips })));

      cards.push({
        id: `offline-${school.toLowerCase()}-${index}-${spellName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: spellName,
        school,
        type,
        pips,
        image
      });
    });
  });

  Object.entries(fusionRecipes).forEach(([school, recipes]) => {
    recipes.forEach((recipe, index) => {
      const alreadyExists = cards.some(
        (card) =>
          card.school === school &&
          normalizeText(card.name) === normalizeText(recipe.result)
      );

      if (alreadyExists) return;

      const type = inferSpellType({
        titleText: recipe.result,
        realName: recipe.result,
        internalName: recipe.result
      });

      cards.push({
        id: `fusion-${school.toLowerCase()}-${index}-${normalizeText(recipe.result)}`,
        name: recipe.result,
        school,
        type,
        pips: 0,
        image: buildLocalSpellImageUrl(school, recipe.result)
      });
    });
  });

  return cards;
}

function loadSpellCatalog() {
  try {
    sampleCards = buildOfflineCardCatalog();
  } catch (error) {
    console.error("[Spell Loader] Critical error loading spell catalog:", error);
  }
}

function createPlayer(index, school = schools[index % schools.length]) {
  return {
    id: `p-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: `Player ${index + 1}`,
    school,
    decks: createEmptyDecks()
  };
}

const deckDefinitions = [
  { id: "main", name: "Main Deck" },
  { id: "extra", name: "Extra Deck" },
  { id: "fusion", name: "Fusion Deck" },
  { id: "treasure", name: "Treasure Card Deck" }
];

function createEmptyDecks() {
  return { main: [], extra: [], fusion: [], treasure: [] };
}

function groupCards(cards = []) {
  const grouped = new Map();
  cards.forEach((entry) => {
    const card = entry.card || entry;
    const quantity = Number(entry.quantity || 1);
    const existing = grouped.get(card.id);
    if (existing) existing.quantity += quantity;
    else grouped.set(card.id, { card, quantity });
  });
  return [...grouped.values()];
}

function normalizePlayerDecks(player) {
  const decks = createEmptyDecks();
  if (player.decks) {
    deckDefinitions.forEach(({ id }) => {
      decks[id] = groupCards(player.decks[id] || []);
    });
  } else {
    decks.main = groupCards(player.cards || []);
  }
  const { cards, ...playerWithoutLegacyCards } = player;
  return { ...playerWithoutLegacyCards, decks };
}

function createTeam(number) {
  const baseSchools = ["Storm", "Fire", "Ice", "Life"];
  return {
    id: `t-${Date.now()}-${number}`,
    name: `Team ${number}`,
    players: Array.from({ length: 4 }, (_, index) => createPlayer(index, baseSchools[(number + index) % baseSchools.length]))
  };
}

const state = {
  raidName: "New Raid",
  teams: [createTeam(1)],
  activeTeamId: null,
  selectedPlayerId: null,
  pickerOpen: false,
  query: "",
  school: "All",
  type: "All",
  draggedTeamId: null,
  chatOpen: false,
  chatDraft: "",
  selectedDeckId: "main",
  expandedDecks: {}
};

state.activeTeamId = state.teams[0].id;
state.selectedPlayerId = state.teams[0].players[0].id;

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeText(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getActiveTeam() {
  return state.teams.find((team) => team.id === state.activeTeamId) || state.teams[0];
}

function getTeamByPlayerId(playerId) {
  return state.teams.find((team) => team.players.some((player) => player.id === playerId)) || null;
}

async function saveStateToFirebase() {

  if (!firebaseReady || !currentUser || applyingRemoteState) {
    return;
  }

  const generationBeingSaved = pendingSaveGeneration;

  try {
    setSaveStatus("Syncing…");

    await setDoc(
      raidDocument,
      {
        raidName: state.raidName,
        teams: state.teams,
        updatedAt: serverTimestamp(),
        updatedBy: {
          uid: currentUser.uid,
          name: participantName
        }
      },
      { merge: true }
    );

    if (generationBeingSaved === pendingSaveGeneration) {
      hasPendingPlannerChanges = false;
      scheduleLiveStatus();
    } else {
      postponePendingSave();
    }

  } catch (error) {
    console.error("Firebase save failed:", error);
    setSaveStatus("Save failed");
  }
}

function scheduleSave() {
  if (!firebaseReady || applyingRemoteState) {
    return;
  }

  hasPendingPlannerChanges = true;
  pendingSaveGeneration += 1;

  postponePendingSave();
}

function postponePendingSave() {
  if (!firebaseReady || !hasPendingPlannerChanges) {
    return;
  }

  window.clearTimeout(saveTimer);
  window.clearTimeout(liveStatusTimer);

  setSaveStatus("Editing…");
  changeVersion += 1;

  saveTimer = window.setTimeout(() => {
    saveStateToFirebase();
  }, 10000);
}

function markChanged() {
  changeVersion += 1;
  window.clearTimeout(liveStatusTimer);
  setSaveStatus("Syncing…");
}

function scheduleLiveStatus() {
  const expectedVersion = changeVersion;
  window.clearTimeout(liveStatusTimer);
  liveStatusTimer = window.setTimeout(() => {
    if (expectedVersion === changeVersion) setSaveStatus("Live", true);
  }, 5000);
}

function setSaveStatus(message, isLive = false) {
  saveStatusText = message;
  saveStatusIsLive = isLive;
  const status = document.getElementById("save-status");
  const dot = document.getElementById("save-status-dot");

  if (status) {
    status.textContent = message;
  }
  if (dot) dot.classList.toggle("live", isLive);
}

function reorderTeams(draggedTeamId, targetTeamId) {
  if (!draggedTeamId || !targetTeamId || draggedTeamId === targetTeamId) return;

  const fromIndex = state.teams.findIndex((team) => team.id === draggedTeamId);
  const toIndex = state.teams.findIndex((team) => team.id === targetTeamId);
  if (fromIndex === -1 || toIndex === -1) return;

  const nextTeams = [...state.teams];
  const [movedTeam] = nextTeams.splice(fromIndex, 1);
  const insertIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
  nextTeams.splice(insertIndex, 0, movedTeam);

  state.teams = nextTeams;

  if (!state.activeTeamId || !state.teams.some((team) => team.id === state.activeTeamId)) {
    state.activeTeamId = state.teams[0]?.id || null;
  }

  if (!state.selectedPlayerId || !state.teams.some((team) => team.players.some((player) => player.id === state.selectedPlayerId))) {
    const activeTeam = getActiveTeam();
    state.selectedPlayerId = activeTeam?.players[0]?.id || null;
  }

  render();
  scheduleSave();
}

function getNextAvailableTeamNumber() {
  const usedNumbers = new Set(
    state.teams
      .map((team) => team.name)
      .filter((name) => /^Team \d+$/.test(name))
      .map((name) => Number(name.replace(/^Team\s+/, "")))
      .filter((value) => Number.isFinite(value))
  );

  let nextNumber = state.teams.length + 1;
  while (usedNumbers.has(nextNumber)) {
    nextNumber += 1;
  }

  return nextNumber;
}

function addTeam() {
  const number = getNextAvailableTeamNumber();
  const team = createTeam(number);
  state.teams.push(team);
  state.activeTeamId = team.id;
  state.selectedPlayerId = team.players[0].id;
  render();
  scheduleSave();
}

function removeTeam(teamId) {
  if (state.teams.length <= 1) return;

  state.teams = state.teams.filter((team) => team.id !== teamId);

  if (state.activeTeamId === teamId || !state.activeTeamId) {
    state.activeTeamId = state.teams[0].id;
  }
  state.selectedPlayerId = state.teams[0].players[0]?.id || null;
  render();
  scheduleSave();
}

function renameTeam(teamId) {
  const team = state.teams.find((entry) => entry.id === teamId);
  if (!team) return;

  const nextName = window.prompt("Rename team:", team.name);
  if (nextName === null) return;

  const trimmed = nextName.trim();
  team.name = trimmed || `Team ${state.teams.indexOf(team) + 1}`;
  render();
  scheduleSave();
}

function addPlayerToTeam(teamId) {
  const team = state.teams.find((entry) => entry.id === teamId);
  if (!team || team.players.length >= 4) return;

  const newPlayer = createPlayer(team.players.length, schools[(team.players.length + state.teams.indexOf(team)) % schools.length]);
  team.players.push(newPlayer);
  state.activeTeamId = team.id;
  state.selectedPlayerId = newPlayer.id;
  render();
  scheduleSave();
}

function removePlayerFromTeam(teamId, playerId) {
  const team = state.teams.find((entry) => entry.id === teamId);
  if (!team) return;

  team.players = team.players.filter((player) => player.id !== playerId);
  if (!team.players.length) {
    team.players.push(createPlayer(0, "Storm"));
  }

  if (state.selectedPlayerId === playerId) {
    state.selectedPlayerId = team.players[0].id;
  }

  render();
  scheduleSave();
}

function updatePlayerName(playerId, value) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  team.players = team.players.map((player) =>
    player.id === playerId ? { ...player, name: value || "Player" } : player
  );
  scheduleSave();
}

function updatePlayerSchool(playerId, school) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  team.players = team.players.map((player) =>
    player.id === playerId ? { ...player, school } : player
  );
  render();
  scheduleSave();
}

function cyclePlayerSchool(playerId) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  const player = team.players.find((entry) => entry.id === playerId);
  if (!player) return;

  const currentIndex = schools.indexOf(player.school);
  const nextSchool = schools[(currentIndex + 1) % schools.length];
  updatePlayerSchool(playerId, nextSchool);
}

function changeCardQuantity(playerId, deckId, cardId, change) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  team.players = team.players.map((player) => {
    if (player.id !== playerId) return player;
    const decks = { ...player.decks };
    decks[deckId] = decks[deckId]
      .map((entry) => entry.card.id === cardId
        ? { ...entry, quantity: entry.quantity + change }
        : entry)
      .filter((entry) => entry.quantity > 0);
    return { ...player, decks };
  });
  render();
  scheduleSave();
}

function addCardToPlayer(card) {
  const team = getTeamByPlayerId(state.selectedPlayerId);
  if (!team) return;

  team.players = team.players.map((player) => {
    if (player.id !== state.selectedPlayerId) return player;
    const decks = { ...player.decks };
    const entries = [...decks[state.selectedDeckId]];
    const existingIndex = entries.findIndex((entry) => entry.card.id === card.id);
    if (existingIndex >= 0) {
      entries[existingIndex] = { ...entries[existingIndex], quantity: entries[existingIndex].quantity + 1 };
    } else {
      entries.push({ card, quantity: 1 });
    }
    decks[state.selectedDeckId] = entries;
    return { ...player, decks };
  });
  state.pickerOpen = false;
  render();
  scheduleSave();
}

function deckExpansionKey(playerId, deckId) {
  return `${playerId}:${deckId}`;
}

function isDeckExpanded(playerId, deckId) {
  const key = deckExpansionKey(playerId, deckId);
  return key in state.expandedDecks ? state.expandedDecks[key] : deckId === "main";
}

function getFusionDeckEntries(player) {
  const mainDeck = player.decks?.main || [];

  const ownedCards = new Map();

  mainDeck.forEach(({ card, quantity }) => {
    ownedCards.set(
      normalizeText(card.name),
      Number(quantity || 0)
    );
  });

  const fusionEntries = [];

  Object.entries(fusionRecipes).forEach(([school, recipes]) => {
    recipes.forEach((recipe, recipeIndex) => {
      /*
       * Count the required copies. This also supports future recipes
       * that might require two copies of the same spell.
       */
      const requiredCounts = new Map();

      recipe.requires.forEach((requiredName) => {
        const normalizedName = normalizeText(requiredName);

        requiredCounts.set(
          normalizedName,
          (requiredCounts.get(normalizedName) || 0) + 1
        );
      });

      const possibleQuantities = [...requiredCounts.entries()].map(
        ([requiredName, requiredQuantity]) => {
          const ownedQuantity = ownedCards.get(requiredName) || 0;

          return Math.floor(ownedQuantity / requiredQuantity);
        }
      );

      const fusionQuantity =
        possibleQuantities.length > 0
          ? Math.min(...possibleQuantities)
          : 0;

      if (fusionQuantity <= 0) return;

      const fusionCard =
        sampleCards.find(
          (card) =>
            card.school === school &&
            normalizeText(card.name) === normalizeText(recipe.result)
        ) || {
          id: `fusion-${school.toLowerCase()}-${recipeIndex}-${normalizeText(recipe.result)}`,
          name: recipe.result,
          school,
          type: inferSpellType({
            titleText: recipe.result,
            realName: recipe.result,
            internalName: recipe.result
          }),
          pips: 0,
          image: buildLocalSpellImageUrl(school, recipe.result)
        };

      fusionEntries.push({
        card: fusionCard,
        quantity: fusionQuantity,
        requires: recipe.requires
      });
    });
  });

  return fusionEntries;
}

function renderPlayerDeck(player, deck) {
  const expanded = isDeckExpanded(player.id, deck.id);
  const entries =
  deck.id === "fusion"
    ? getFusionDeckEntries(player)
    : player.decks[deck.id] || [];
  const totalCards = entries.reduce((total, entry) => total + entry.quantity, 0);
  return `
    <section class="player-deck ${expanded ? "expanded" : "collapsed"}">
      <button class="deck-header" data-toggle-deck="${player.id}|${deck.id}" aria-expanded="${expanded}">
        <span>${expanded ? "▾" : "▸"} ${escapeHtml(deck.name)}</span>
        <strong>${totalCards}</strong>
      </button>
      ${expanded ? `
        <div class="assigned-cards">
          ${entries.length ? `<div class="card-grid">
            ${entries.map(({ card, quantity }) => `
              <div class="card-slot" style="--school-gradient:${getSchoolGradient(card.school)}; --school-accent:${schoolPalette[card.school]?.accent || '#ffffff'};">
                <div class="spell-card-wrap">
                  ${shouldShowSchoolBadge(card.image) ? getSchoolBadgeMarkup(card.school) : ""}
                  <img class="spell-image" src="${card.image}" loading="lazy" decoding="async" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${card.type}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
                </div>
                ${
                  deck.id === "fusion"
                    ? `
                      <div class="quantity-control fusion-quantity">
                        <strong>×${quantity}</strong>
                      </div>
                    `
                    : `
                      <div class="quantity-control">
                        <button
                          data-card-quantity="${player.id}|${deck.id}|${card.id}|-1"
                          aria-label="Remove one ${escapeHtml(card.name)}"
                        >−</button>

                        <strong>×${quantity}</strong>

                        <button
                          data-card-quantity="${player.id}|${deck.id}|${card.id}|1"
                          aria-label="Add one ${escapeHtml(card.name)}"
                        >＋</button>
                      </div>
                    `
                }
              </div>`).join("")}
          </div>` : ""}
          ${
            deck.id === "fusion"
              ? `
                <div class="derived-deck-note">
                  Automatically generated from Main Deck
                </div>
              `
              : `
                <button
                  class="mini-add"
                  data-open-picker-player="${player.id}|${deck.id}"
                >
                  ＋ Add Card
                </button>
              `
          }
        </div>` : ""}
    </section>`;
}

function renderTeamCard(team) {
  return `
    <section class="team-panel ${team.id === state.activeTeamId ? "active" : ""}">
      <div class="team-panel-header">
        <button class="team-panel-name" data-team-id="${team.id}">${escapeHtml(team.name)}</button>
        <div class="team-panel-actions">
          <button class="mini-team-add" data-add-player-team="${team.id}" ${team.players.length >= 4 ? "disabled" : ""}>+ Add Player</button>
          <button class="team-rename" data-rename-team="${team.id}">Rename</button>
          <button class="team-remove" data-remove-team="${team.id}" ${state.teams.length <= 1 ? "disabled" : ""}>Remove Team</button>
        </div>
      </div>

      <div class="team-player-grid">
        ${team.players.map((player) => `
          <div class="player-column" data-player-card="${player.id}">
            <div class="player-editor">
              <button class="school-icon" type="button" data-cycle-school="${player.id}" aria-label="Change ${escapeHtml(player.name)} school">
                <img src="${getSchoolLogoSvg(player.school)}" alt="${player.school}" />
              </button>
              <input class="player-name-input" data-player-name="${player.id}" value="${escapeHtml(player.name)}" />
              <button class="player-remove" data-remove-player="${team.id}|${player.id}">✕</button>
            </div>

            <div class="player-decks">
              ${deckDefinitions.map((deck) => renderPlayerDeck(player, deck)).join("")}
            </div>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function render() {
  const normalizedQuery = normalizeText(state.query);
  const filteredCards = sampleCards.filter((card) => {
    const matchesQuery = !normalizedQuery || normalizeText(card.name).includes(normalizedQuery) || normalizeText(card.school).includes(normalizedQuery) || normalizeText(card.type).includes(normalizedQuery);
    const matchesSchool = state.school === "All" || card.school === state.school;
    const matchesType = state.type === "All" || card.type === state.type;
    return matchesQuery && matchesSchool && matchesType;
  });

  const app = document.getElementById("app");

  app.innerHTML = `
    <div class="app">
      <header class="topbar">
        <div>
          <div class="eyebrow">WIZARD101</div>
          <h1>Raid Planner</h1>
        </div>
        <div class="top-actions">
          <input class="raid-name" id="raid-name-input" value="${escapeHtml(state.raidName)}" />
          <button class="secondary copy-link-btn" id="copy-link-btn">⧉ Copy raid link</button>
          <div class="sync-status" aria-live="polite">
            <span id="save-status-dot" class="sync-dot ${saveStatusIsLive ? "live" : ""}"></span>
            <span id="save-status" class="save-status">${escapeHtml(saveStatusText)}</span>
          </div>
        </div>
      </header>

      <div class="workspace">
        <aside class="sidebar">
          <div class="section-title">
            <span>TEAMS</span>
            <button class="icon-btn" id="add-team-btn">＋</button>
          </div>

          <div class="team-list">
            ${state.teams.map((entry) => `
              <button
                class="team-tab ${entry.id === state.activeTeamId ? "active" : ""}"
                data-team-id="${entry.id}"
                draggable="true"
                aria-label="Reorder ${escapeHtml(entry.name)}"
              >
                <span>${escapeHtml(entry.name)}</span>
                <strong>${entry.players.length}/4</strong>
              </button>
            `).join("")}
          </div>
          <div class="participants-panel">
            <div class="section-title"><span>PARTICIPANTS</span></div>
            <div id="participant-list" class="participant-list"></div>
          </div>
        </aside>

        <main class="main">
          <div class="team-header">
            <div>
              <div class="eyebrow">MATCHUP</div>
              <h2>Team View</h2>
            </div>
          </div>

          <div class="team-grid">
            ${state.teams.map((team) => renderTeamCard(team)).join("")}
          </div>
        </main>
      </div>
      
      ${state.chatOpen ? `<aside class="chat-panel">
        <div class="chat-header">
          <div>
            <div class="eyebrow">LIVE DISCUSSION</div>
            <strong id="chat-user-name">${escapeHtml(participantName)}</strong>
          </div>

          <button class="icon-btn" id="close-chat-btn" aria-label="Close chat">✕</button>
        </div>

        <div id="chat-messages" class="chat-messages"></div>

        <form id="chat-form" class="chat-form">
          <input
            id="chat-input"
            type="text"
            maxlength="500"
            autocomplete="off"
            placeholder="Write a message..."
            value="${escapeHtml(state.chatDraft)}"
          />
          <button type="submit" class="primary">Send</button>
        </form>
      </aside>` : ""}
      <button class="chat-toggle" id="chat-toggle-btn" aria-label="Toggle chat">
        <span>💬</span><strong>Chat</strong>
      </button>

      ${state.pickerOpen ? `
        <div class="modal-backdrop" id="modal-backdrop">
          <div class="picker">
            <div class="picker-header">
              <div>
                <div class="eyebrow">CARD LIBRARY</div>
                <h2>Add to ${escapeHtml(deckDefinitions.find((deck) => deck.id === state.selectedDeckId)?.name || "Deck")}</h2>
              </div>
              <button class="icon-btn" id="close-picker-btn">✕</button>
            </div>

            <div class="filters">
              <div class="search-box">
                <span>🔎</span>
                <input id="card-search" placeholder="Search spells..." value="${escapeHtml(state.query)}" />
              </div>
              <label>
                School
                <select id="filter-school">
                  <option value="All" ${state.school === "All" ? "selected" : ""}>All</option>
                  ${schools.map((school) => `
                    <option value="${school}" ${state.school === school ? "selected" : ""}>${school}</option>`).join("")}
                </select>
              </label>
              <label>
                Type
                <select id="filter-type">
                  <option value="All" ${state.type === "All" ? "selected" : ""}>All</option>
                  ${cardTypes.map((type) => `
                    <option value="${type}" ${state.type === type ? "selected" : ""}>${type}</option>`).join("")}
                </select>
              </label>
            </div>

            <div class="card-library">
              ${filteredCards.length ? filteredCards.map((card) => `
                <button class="library-card" data-card-id="${card.id}" style="--school-gradient:${getSchoolGradient(card.school)}; --school-accent:${schoolPalette[card.school]?.accent || '#ffffff'};">
                  <div class="library-card-image-wrap">
                    ${shouldShowSchoolBadge(card.image) ? getSchoolBadgeMarkup(card.school) : ""}
                    <img class="library-image" src="${card.image}" loading="lazy" decoding="async" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${card.type}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
                  </div>
                  <div class="library-info">
                    <strong>${escapeHtml(card.name)}</strong>
                    <span>${escapeHtml(card.school)} · ${escapeHtml(card.type)}</span>
                  </div>
                </button>
              `).join("") : '<div class="no-results">No spells match your filters.</div>'}
            </div>
          </div>
        </div>
      ` : ""}
    </div>
  `;

  document.getElementById("raid-name-input")?.addEventListener("input", (event) => {
  state.raidName = event.target.value;
  scheduleSave();
});

  document.getElementById("copy-link-btn")?.addEventListener("click", copyRaidLink);
  document.getElementById("chat-toggle-btn")?.addEventListener("click", () => {
    state.chatOpen = !state.chatOpen;
    render();
  });
  document.getElementById("close-chat-btn")?.addEventListener("click", () => {
    state.chatOpen = false;
    render();
  });
  document.getElementById("add-team-btn")?.addEventListener("click", addTeam);
  document.getElementById("open-picker-btn")?.addEventListener("click", () => {
    state.pickerOpen = true;
    render();
  });

  document.getElementById("close-picker-btn")?.addEventListener("click", () => {
    state.pickerOpen = false;
    render();
  });

  document.getElementById("modal-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") {
      state.pickerOpen = false;
      render();
    }
  });

  document.getElementById("card-search")?.addEventListener("input", (event) => {
    state.query = event.target.value;
    render();
    requestAnimationFrame(() => {
      const searchBox = document.getElementById("card-search");
      if (searchBox) {
        searchBox.focus();
        const len = searchBox.value.length;
        searchBox.setSelectionRange(len, len);
      }
    });
  });

  document.getElementById("filter-school")?.addEventListener("change", (event) => {
    state.school = event.target.value;
    render();
  });

  document.getElementById("filter-type")?.addEventListener("change", (event) => {
    state.type = event.target.value;
    render();
  });

  document.querySelectorAll(".team-tab")?.forEach((element) => {
    element.addEventListener("click", () => {
      state.activeTeamId = element.getAttribute("data-team-id");
      state.selectedPlayerId = getActiveTeam().players[0]?.id || null;
      render();
    });

    element.addEventListener("dragstart", (event) => {
      const teamId = element.getAttribute("data-team-id");
      state.draggedTeamId = teamId;
      element.classList.add("dragging");
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", teamId);
      }
    });

    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "move";
      }
      element.classList.add("drop-target");
    });

    element.addEventListener("dragleave", () => {
      element.classList.remove("drop-target");
    });

    element.addEventListener("drop", (event) => {
      event.preventDefault();
      const targetTeamId = element.getAttribute("data-team-id");
      element.classList.remove("drop-target");
      if (state.draggedTeamId && targetTeamId) {
        reorderTeams(state.draggedTeamId, targetTeamId);
      }
    });

    element.addEventListener("dragend", () => {
      state.draggedTeamId = null;
      element.classList.remove("dragging", "drop-target");
    });
  });

  document.querySelectorAll("[data-team-id]")?.forEach((element) => {
    if (element.classList.contains("team-tab")) return;
    element.addEventListener("click", () => {
      state.activeTeamId = element.getAttribute("data-team-id");
      state.selectedPlayerId = getActiveTeam().players[0]?.id || null;
      render();
    });
  });

  document.querySelectorAll("[data-add-player-team]")?.forEach((element) => {
    element.addEventListener("click", () => {
      addPlayerToTeam(element.getAttribute("data-add-player-team"));
    });
  });

  document.querySelectorAll("[data-player-name]")?.forEach((element) => {
    element.addEventListener("input", (event) => {
      const playerId = element.getAttribute("data-player-name");
      updatePlayerName(playerId, event.target.value);
    });
  });

  document.querySelectorAll("[data-cycle-school]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const playerId = element.getAttribute("data-cycle-school");
      cyclePlayerSchool(playerId);
    });
  });

  document.querySelectorAll("[data-rename-team]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const teamId = element.getAttribute("data-rename-team");
      renameTeam(teamId);
    });
  });

  document.querySelectorAll("[data-remove-team]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const teamId = element.getAttribute("data-remove-team");
      removeTeam(teamId);
    });
  });

  document.querySelectorAll("[data-remove-player]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const [teamId, playerId] = element.getAttribute("data-remove-player").split("|");
      removePlayerFromTeam(teamId, playerId);
    });
  });

  document.querySelectorAll("[data-open-picker-player]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, deckId] = element.getAttribute("data-open-picker-player").split("|");
      const team = getTeamByPlayerId(playerId);
      if (team) state.activeTeamId = team.id;
      state.selectedPlayerId = playerId;
      state.selectedDeckId = deckId;
      state.pickerOpen = true;
      render();
    });
  });

  document.querySelectorAll("[data-toggle-deck]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, deckId] = element.getAttribute("data-toggle-deck").split("|");
      const key = deckExpansionKey(playerId, deckId);
      state.expandedDecks[key] = !isDeckExpanded(playerId, deckId);
      render();
    });
  });

  document.querySelectorAll("img.spell-image, img.library-image")?.forEach((img) => {
    img.addEventListener("error", (event) => {
      const cardName = (img.dataset.cardName || "Unknown spell").replace(/&amp;/g, "&");
      const card = {
        name: cardName,
        school: img.dataset.cardSchool || "Balance",
        type: img.dataset.cardType || "Utility",
        pips: Number(img.dataset.cardPips || 0)
      };
      handleImageFailure(event, card);
    });
  });

  document.querySelectorAll("[data-card-id]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const cardId = element.getAttribute("data-card-id");
      const card = sampleCards.find((entry) => entry.id === cardId);
      if (card) addCardToPlayer(card);
    });
  });

  document.querySelectorAll("[data-card-quantity]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, deckId, cardId, change] = element.getAttribute("data-card-quantity").split("|");
      changeCardQuantity(playerId, deckId, cardId, Number(change));
    });
  });

  document.getElementById("chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = document.getElementById("chat-input");
    if (!input) return;

    const message = input.value;
    input.value = "";
    state.chatDraft = "";

    try {
      await sendChatMessage(message);
    } catch (error) {
      console.error("Message could not be sent:", error);
      input.value = message;
      state.chatDraft = message;
    }
  });
  document.getElementById("chat-input")?.addEventListener("input", (event) => {
    state.chatDraft = event.target.value;
  });

  renderMessages(latestMessages);
  renderParticipants();
}

function registerUserActivity() {
  if (hasPendingPlannerChanges) {
    postponePendingSave();
  }
}

document.addEventListener("input", registerUserActivity, true);
document.addEventListener("change", registerUserActivity, true);
document.addEventListener("pointerdown", registerUserActivity, true);
document.addEventListener("keydown", registerUserActivity, true);

function getMessagesCollection() {
  return collection(db, "raids", raidId, "messages");
}

async function copyRaidLink() {
  const button = document.getElementById("copy-link-btn");
  try {
    await navigator.clipboard.writeText(window.location.href);
  } catch {
    const input = document.createElement("textarea");
    input.value = window.location.href;
    document.body.appendChild(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }
  if (button) button.textContent = "✓ Link copied";
  window.setTimeout(() => {
    if (button?.isConnected) button.textContent = "⧉ Copy raid link";
  }, 1800);
}

function participantsCollection() {
  return collection(db, "raids", raidId, "participants");
}

async function updatePresence() {
  if (!currentUser) return;

  await setDoc(
    doc(participantsCollection(), currentUser.uid),
    {
      uid: currentUser.uid,
      name: participantName,
      lastSeen: serverTimestamp()
    },
    { merge: true }
  );
}

function startPresence() {
  allParticipants = [
    {
      uid: currentUser.uid,
      name: participantName,
      lastSeen: null
    }
  ];

  renderParticipants();

  updatePresence().catch(console.error);

  window.clearInterval(presenceInterval);

  presenceInterval = window.setInterval(() => {
    updatePresence().catch(console.error);
    renderParticipants();
  }, 20000);

  if (unsubscribeParticipants) {
    unsubscribeParticipants();
  }

  unsubscribeParticipants = onSnapshot(
    participantsCollection(),
    (snapshot) => {
      allParticipants = snapshot.docs
        .map((participantDocument) => ({
          id: participantDocument.id,
          ...participantDocument.data()
        }))
        .sort((a, b) =>
          String(a.name || "").localeCompare(String(b.name || ""))
        );

      renderParticipants();
    },
    (error) => {
      console.error("Participant presence listener failed:", error);

      const list = document.getElementById("participant-list");

      if (list) {
        list.innerHTML =
          '<div class="participants-empty">Presence unavailable</div>';
      }
    }
  );

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      updatePresence().catch(console.error);
    }
  });
}

// Pointer-clicked buttons should not retain focus and activate again when the
// user later presses Space to scroll or type elsewhere. Keyboard navigation
// remains unchanged because this only runs after pointer interaction.
document.addEventListener("pointerup", (event) => {
  const button = event.target.closest?.("button");
  if (button) requestAnimationFrame(() => button.blur());
});

function renderParticipants() {
  const list = document.getElementById("participant-list");
  if (!list) return;

  const onlineLimit = Date.now() - 45000;

  const onlineParticipants = allParticipants.filter((participant) => {
    if (participant.uid === currentUser?.uid) {
      return true;
    }

    const lastSeen = participant.lastSeen?.toMillis?.();

    return typeof lastSeen === "number" && lastSeen >= onlineLimit;
  });

  const participantMarkup = (participant) => `
    <div class="participant online">
      <span class="participant-dot"></span>

      <span title="${escapeHtml(participant.name || "Anonymous")}">
        ${escapeHtml(participant.name || "Anonymous")}
      </span>

      ${
        participant.uid === currentUser?.uid
          ? "<small>You</small>"
          : ""
      }
    </div>
  `;

  list.innerHTML = `
    <div class="presence-group">
      <div class="presence-group-title">
        <span>ONLINE</span>
        <strong>${onlineParticipants.length}</strong>
      </div>

      ${
        onlineParticipants.length
          ? onlineParticipants.map(participantMarkup).join("")
          : '<div class="participants-empty">Nobody online</div>'
      }
    </div>
  `;
}

async function sendChatMessage(text) {
  const normalizedText = text.trim();

  if (!currentUser || !normalizedText) {
    return;
  }

  await addDoc(getMessagesCollection(), {
    text: normalizedText.slice(0, 500),
    authorId: currentUser.uid,
    authorName: participantName,
    createdAt: serverTimestamp()
  });
}

function subscribeToMessages() {
  if (unsubscribeMessages) {
    unsubscribeMessages();
  }

  const messagesQuery = query(
    getMessagesCollection(),
    orderBy("createdAt", "asc"),
    limit(100)
  );

  unsubscribeMessages = onSnapshot(
    messagesQuery,
    (snapshot) => {
      latestMessages = snapshot.docs.map((messageDocument) => ({
        id: messageDocument.id,
        ...messageDocument.data()
      }));

      renderMessages(latestMessages);
    },
    (error) => {
      console.error("Chat listener failed:", error);
    }
  );
}

function renderMessages(messages) {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  container.innerHTML = messages
    .map((message) => {
      const mine = message.authorId === currentUser?.uid;

      return `
        <div class="chat-message ${mine ? "mine" : ""}">
          <strong>${escapeHtml(message.authorName || "Anonymous")}</strong>
          <p>${escapeHtml(message.text || "")}</p>
        </div>
      `;
    })
    .join("");

  container.scrollTop = container.scrollHeight;
}


function subscribeToRaid() {
  if (unsubscribeRaid) {
    unsubscribeRaid();
  }

  unsubscribeRaid = onSnapshot(
    raidDocument,
    async (snapshot) => {
      if (!snapshot.exists()) {
        await saveStateToFirebase();
        return;
      }

      const savedRaid = snapshot.data();

      applyingRemoteState = true;

      if (typeof savedRaid.raidName === "string") {
        state.raidName = savedRaid.raidName;
      }

      if (Array.isArray(savedRaid.teams) && savedRaid.teams.length > 0) {
        state.teams = savedRaid.teams.map((team) => ({
          ...team,
          players: team.players.map(normalizePlayerDecks)
        }));
      }

      const activeTeamStillExists = state.teams.some(
        (team) => team.id === state.activeTeamId
      );

      if (!activeTeamStillExists) {
        state.activeTeamId = state.teams[0]?.id || null;
      }

      const selectedPlayerStillExists = state.teams.some((team) =>
        team.players.some(
          (player) => player.id === state.selectedPlayerId
        )
      );

      if (!selectedPlayerStillExists) {
        const activeTeam = getActiveTeam();
        state.selectedPlayerId = activeTeam?.players[0]?.id || null;
      }

      render();
      applyingRemoteState = false;
      markChanged();
      scheduleLiveStatus();
    },
    (error) => {
      console.error("Raid listener failed:", error);
      setSaveStatus("Connection failed");
    }
  );
}

(async () => {
  loadSpellCatalog();
  render();
  await startFirebase();
})();
