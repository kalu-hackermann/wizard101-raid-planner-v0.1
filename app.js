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
let latestMessages = [];

function askForParticipantName() {
  while (!participantName.trim()) {
    participantName =
      window.prompt("Enter the name other raid members should see:")?.trim() || "";
  }

  participantName = participantName.slice(0, 30);
  localStorage.setItem("wizard101-participant-name", participantName);
}

async function startFirebase() {
  askForParticipantName();

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
  });
}

const schools = ["Storm", "Fire", "Ice", "Life", "Death", "Myth", "Balance"];
const cardTypes = ["Attack", "Blade", "Trap", "Shield", "Heal", "Utility"];

const schoolPalette = {
  Storm: { accent: "#7f5af0", glow: "#f4d35e", panel: "#241b45" },
  Fire: { accent: "#ff4d4d", glow: "#f7d154", panel: "#6c1d1d" },
  Ice: { accent: "#bfe8ff", glow: "#ffffff", panel: "#3c6c8d" },
  Life: { accent: "#9fe79a", glow: "#3ca86d", panel: "#17412e" },
  Death: { accent: "#0d0d0d", glow: "#f5f5f5", panel: "#2a2a2a" },
  Myth: { accent: "#f7d75b", glow: "#4a7ed8", panel: "#1d2a4a" },
  Balance: { accent: "#d9b98a", glow: "#7e2d2d", panel: "#432422" }
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
    Storm: "Storm school"
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
    "Fire Elf",
    "Glacial Shield",
    "Sunbird",
    "Fire Trap",
    "Glacial Golem",
    "Meteor Strike",
    "Immolate",
    "Wyldfire",
    "Phoenix",
    "Naphtha Scarab",
    "Helephant",
    "Inferno Salamander",
    "Meltdown",
    "Backfire",
    "Fire Dragon",
    "Efreet",
    "Jinn's Reversal",
    "Rain of Fire",
    "Caldera Jinn",
    "Sun Serpent",
    "King Artorius (Fire)",
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
    "Burning Rampage",
    "Fires of Mars",
    "Hephaestus",
    "Jackall & Hound",
    "Krampus",
    "Nautilus Unleashed",
    "Whitehart Fire",
    "Fireblade",
    "Fire Prism",
    "Link",
    "Steal Charm",
    "Heck Hound",
    "Immolate",
    "Choke",
    "Fire Elemental",
    "Scald",
    "Fuel",
    "Smoke Screen",
    "Fire Dragon",
    "Power Link",
    "Efreet",
    "Rain of Fire",
    "Detonate",
    "Backdraft",
    "Sir Lamorak",
    "Sun Serpent",
    "King Artorius (Fire)",
    "Fire from Above",
    "Raging Bull",
    "Scorching Scimitars",
    "Scion of Fire",
    "S'more Machine",
    "Blast Off!",
    "Glimpse of Infinity",
    "Phantasmania!",
    "Ammut",
    "The Chariot",
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
    "Scorpion",
    "Weakness",
    "Locust Swarm",
    "Sandstorm",
    "Elemental Golem",
    "Gearhead Destroyer",
    "Balance of Power",
    "Spectral Blast",
    "Donate Power",
    "Blade Dilution",
    "Trap Dilution",
    "Iron Curse",
    "Hydra",
    "Obsidian Colossus",
    "Righting the Scales",
    "Eye of Vigilance",
    "Power Nova",
    "Ra",
    "Jinn's Fortune",
    "Chimera",
    "Duststorm Jinn",
    "Courageous Charge",
    "Spinning Scythe",
    "Sabertooth",
    "King Artorius (Balance)",
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
    "Dyvim's Resurgence",
    "Loremaster",
    "Ninja Piglets",
    "Pops' Knuckles",
    "Samoorai",
    "Savage Paw",
    "Spiritual Tribunal",
    "Steal Pip",
    "Terminus' Strike",
    "Elemental Shield",
    "Precision",
    "Spirit Shield",
    "Balanceblade",
    "Black Mantle",
    "Mander Minion",
    "Helping Hands",
    "Hex",
    "Judgement",
    "Bladestorm",
    "Elemental Defuse",
    "Spirit Defuse",
    "Spectral Minion",
    "Power Nova",
    "Availing Hands",
    "Ra",
    "Chimera",
    "Mana Burn",
    "Supernova",
    "Nerys",
    "Sabertooth",
    "King Artorius (Balance)",
    "Gaze of Fate",
    "Nested Fury",
    "Sand Wurm",
    "Scion of Balance",
    "Mockenspiel",
    "Old One's Endgame",
    "Scales of Destiny",
    "Rainbow Serpent",
    "Chameleon Clash",
    "Wheel of Fortune",
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
  ]
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
      const localImage = ["Fire", "Balance", "Death", "Ice", "Life", "Myth", "Storm"].includes(school)
        ? buildLocalSpellImageUrl(school, spellName)
        : "";
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

  return cards;
}

async function loadSpellCatalog() {
  try {
    console.log("[Spell Loader] Using built-in fallback spell catalog for instant UI loading.");
    sampleCards = buildOfflineCardCatalog();

    if (typeof render === "function") {
      render();
    }

    for (const [school, wikiUrl] of Object.entries(schoolWikiUrls)) {
      try {
        console.log(`[Spell Loader] Best-effort fetch for ${school} from ${wikiUrl}`);
        const rawWikiText = await fetchWikiText(wikiUrl);
        const liveSpellNames = parseSchoolSpellNames(rawWikiText);
        if (liveSpellNames.length > 0) {
          console.log(`[Spell Loader] Wiki data loaded for ${school}:`, liveSpellNames);
        }
      } catch (error) {
        console.warn(`[Spell Loader] Wiki fetch failed for ${school}; offline catalog remains active.`, error);
      }
    }
  } catch (error) {
    console.error("[Spell Loader] Critical error loading spell catalog:", error);
  }
}

function createPlayer(index, school = schools[index % schools.length]) {
  return {
    id: `p-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: `Player ${index + 1}`,
    school,
    cards: []
  };
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
  draggedTeamId: null
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

  try {
    setSaveStatus("Saving...");

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

    setSaveStatus("Saved");
  } catch (error) {
    console.error("Firebase save failed:", error);
    setSaveStatus("Save failed");
  }
}

function scheduleSave() {
  if (!firebaseReady || applyingRemoteState) {
    return;
  }

  window.clearTimeout(saveTimer);

  saveTimer = window.setTimeout(() => {
    saveStateToFirebase();
  }, 500);
}

function setSaveStatus(message) {
  const status = document.getElementById("save-status");

  if (status) {
    status.textContent = message;
  }
}

function loadSavedState() {
  try {
    const saved = JSON.parse(localStorage.getItem("wizard101-raid-planner") || "null");
    if (!saved) return;
    if (saved.raidName) state.raidName = saved.raidName;
    if (saved.teams && saved.teams.length) {
      const preferredTeams = saved.teams.length > 1 ? [saved.teams[0]] : saved.teams;
      state.teams = preferredTeams;
      state.activeTeamId = preferredTeams[0].id;
      state.selectedPlayerId = preferredTeams[0].players[0]?.id || null;
    }
  } catch (error) {
    console.warn("Failed to load saved raid data", error);
  }
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
  addPlayerToTeam();
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

function removeCardFromPlayer(playerId, cardId) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  team.players = team.players.map((player) =>
    player.id === playerId ? { ...player, cards: player.cards.filter((card) => card.id !== cardId) } : player
  );
  render();
  scheduleSave();
}

function addCardToPlayer(card) {
  const team = getTeamByPlayerId(state.selectedPlayerId);
  if (!team) return;

  team.players = team.players.map((player) =>
    player.id === state.selectedPlayerId ? { ...player, cards: [...player.cards, card] } : player
  );
  state.pickerOpen = false;
  render();
  scheduleSave();
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

            <div class="assigned-cards">
              ${player.cards.length > 0 ? `
                <div class="card-grid">
                  ${player.cards.map((card) => `
                    <div class="card-slot" style="--school-gradient:${getSchoolGradient(card.school)}; --school-accent:${schoolPalette[card.school]?.accent || '#ffffff'};">
                      <div class="spell-card-wrap">
                        ${shouldShowSchoolBadge(card.image) ? getSchoolBadgeMarkup(card.school) : ""}
                        <img class="spell-image" src="${card.image}" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${card.type}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
                      </div>
                      <button class="card-remove" data-remove-card="${player.id}|${card.id}">✕</button>
                    </div>
                  `).join("")}
                </div>
              ` : ""}

              <button class="mini-add" data-open-picker-player="${player.id}">＋ Add Card</button>
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
          <div class="save-area">
            <span id="save-status" class="save-status">Connecting...</span>
            <button class="primary" id="save-btn">💾 Save now</button>
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
      
      <aside class="chat-panel">
        <div class="chat-header">
          <div>
            <div class="eyebrow">LIVE DISCUSSION</div>
            <strong id="chat-user-name">${escapeHtml(participantName)}</strong>
          </div>

          <span class="online-indicator">● Live</span>
        </div>

        <div id="chat-messages" class="chat-messages"></div>

        <form id="chat-form" class="chat-form">
          <input
            id="chat-input"
            type="text"
            maxlength="500"
            autocomplete="off"
            placeholder="Write a message..."
          />
          <button type="submit" class="primary">Send</button>
        </form>
      </aside>

      ${state.pickerOpen ? `
        <div class="modal-backdrop" id="modal-backdrop">
          <div class="picker">
            <div class="picker-header">
              <div>
                <div class="eyebrow">CARD LIBRARY</div>
                <h2>Select a Spell</h2>
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
                    <img class="library-image" src="${card.image}" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${card.type}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
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

  document
    .getElementById("save-btn")
    ?.addEventListener("click", saveStateToFirebase);
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
      const playerId = element.getAttribute("data-open-picker-player");
      const team = getTeamByPlayerId(playerId);
      if (team) state.activeTeamId = team.id;
      state.selectedPlayerId = playerId;
      state.pickerOpen = true;
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

  document.querySelectorAll("[data-remove-card]")?.forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, cardId] = element.getAttribute("data-remove-card").split("|");
      removeCardFromPlayer(playerId, cardId);
    });
  });

  document.getElementById("chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = document.getElementById("chat-input");
    if (!input) return;

    const message = input.value;
    input.value = "";

    try {
      await sendChatMessage(message);
    } catch (error) {
      console.error("Message could not be sent:", error);
      input.value = message;
    }
  });

  renderMessages(latestMessages);
}


function getMessagesCollection() {
  return collection(db, "raids", raidId, "messages");
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
        state.teams = savedRaid.teams;
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
      setSaveStatus("Live");
    },
    (error) => {
      console.error("Raid listener failed:", error);
      setSaveStatus("Connection failed");
    }
  );
}

(async () => {
  await loadSpellCatalog();
  render();
  await startFirebase();
})();
