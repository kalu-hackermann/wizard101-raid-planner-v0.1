import { auth, db } from "./firebase.js";

import {
  offlineSchoolSpellNames,
  offlineSchoolSpellNamesTreasureCards,
  offlineSchoolSpellNamesExtraDeck,
  fusionRecipes,
  spellCategoryOverrides
} from "./spell-data.js";

import {
  onAuthStateChanged,
  signInAnonymously
} from "firebase/auth";

import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
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
let unsubscribePlayerSections = null;
let unsubscribeMessages = null;
let unsubscribeParticipants = null;
let presenceInterval = null;
let latestMessages = [];
let allParticipants = [];
let messagesInitialized = false;
let unreadMessageCount = 0;
let chatAudioContext = null;
let liveStatusTimer = null;
let changeVersion = 0;
let hasPendingPlannerChanges = false;
let pendingSaveGeneration = 0;
let pendingStructureSave = false;
let pendingRaidNameSave = false;
let pendingPlayerIds = new Set();
const latestPlayerSections = new Map();
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
      unlockChatAudio();
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
    subscribeToPlayerSections();
    subscribeToMessages();
    startPresence();
  });
}

const schools = ["Storm", "Fire", "Ice", "Life", "Death", "Myth", "Balance", "Shadow"];
const cardLibrarySchools = [...schools, "Sun", "Star", "Moon"];
const cardTypes = [
  "Buffs and debuffs",
  "Shields",
  "Traps",
  "Field spells",
  "DOTs",
  "Area of Effect (AOE)",
  "Single target spells",
  "Heals"
];

const schoolPalette = {
  Storm: { accent: "#7f5af0", glow: "#f4d35e", panel: "#241b45" },
  Fire: { accent: "#ff4d4d", glow: "#f7d154", panel: "#6c1d1d" },
  Ice: { accent: "#bfe8ff", glow: "#ffffff", panel: "#3c6c8d" },
  Life: { accent: "#9fe79a", glow: "#3ca86d", panel: "#17412e" },
  Death: { accent: "#0d0d0d", glow: "#f5f5f5", panel: "#2a2a2a" },
  Myth: { accent: "#f7d75b", glow: "#4a7ed8", panel: "#1d2a4a" },
  Balance: { accent: "#d9b98a", glow: "#7e2d2d", panel: "#432422" },
  Shadow: { accent: "#8b5cf6", glow: "#d8b4fe", panel: "#1d102d" },
  Sun: { accent: "#f6d25c", glow: "#f7d49f", panel: "#8b4f00" },
  Star: { accent: "#feffba", glow: "#d5ffa6", panel: "#b9b883" },
  Moon: { accent: "#a1ffff", glow: "#52dafc", panel: "#e7f7fc" }
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

function buildLocalSpellImageUrl(school, spellName, subfolder = "") {
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
    Shadow: "Shadow school",
    Sun: "Sun school",
    Star: "Star school",
    Moon: "Moon school"
  };

  const folderName = folderNames[normalizedSchool];
  if (!folderName) return "";

  const pathSegments = [folderName];
  if (subfolder) pathSegments.push(subfolder);
  pathSegments.push(`${normalizedSpellName}.png`);

  return `/pictures/${pathSegments.map(encodeURIComponent).join("/")}`;
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

const fusionSpellKeys = new Set(
  Object.entries(fusionRecipes).flatMap(([school, recipes]) =>
    recipes
      .filter(
        (recipe) =>
          recipe &&
          typeof recipe.result === "string" &&
          Array.isArray(recipe.requires)
      )
      .map((recipe) => `${school}:${normalizeText(recipe.result)}`)
  )
);

function isFusionSpell(card) {
  return fusionSpellKeys.has(
    `${card.school}:${normalizeText(card.name)}`
  );
}

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
let extraDeckCards = [];
let treasureDeckCards = [];

function inferSpellCategories(card) {
  const rawName = String(
    card.name ||
    card.titleText ||
    card.realName ||
    card.internalName ||
    ""
  );
  const name = normalizeText(rawName);
  const baseName = normalizeText(rawName.replace(/\s+[A-D]$/i, ""));

  const explicitCategories = spellCategoryOverrides[name] || spellCategoryOverrides[baseName];

  if (explicitCategories) {
    return explicitCategories;
  }

  if (/trap|hex|feint|curse|jinx|snare/.test(name)) {
    return ["Traps"];
  }

  if (/shield|ward|armor/.test(name)) {
    return ["Shields"];
  }

  if (
    /blade|weakness|plague|infection|precision|amplify|fortify|brace|frenzy|berserk/.test(name)
  ) {
    return ["Buffs and debuffs"];
  }

  if (/heal|healing|regenerate/.test(name)) {
    return ["Heals"];
  }

  // Unknown cards remain available under "All".
  return [];
}

function getCardCategories(card) {
  if (Array.isArray(card.categories)) {
    return card.categories;
  }

  // Compatibility with cards previously saved in Firebase.
  const legacyTypeMap = {
    Blade: "Buffs and debuffs",
    Shield: "Shields",
    Trap: "Traps",
    Heal: "Heals"
  };

  if (card.type && legacyTypeMap[card.type]) {
    return [legacyTypeMap[card.type]];
  }

  return inferSpellCategories(card);
}

function getCardCategoryLabel(card) {
  const categories = getCardCategories(card);
  return categories.length ? categories.join(" · ") : "Other";
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
      const categories = Array.isArray(spell.categories)? spell.categories: inferSpellCategories({ name: spellName });
      const pips = Number(spell.pips ?? 4);
      const localImage = buildLocalSpellImageUrl(school, spellName);
      const image = localImage || (school === "Fire" && fireSpellImageMap[spellName]
        ? fireSpellImageMap[spellName]
        : (spell.image || getFallbackCardImage({ name: spellName, school, type: categories[0] || "Other", pips })));

      cards.push({
        id: `offline-${school.toLowerCase()}-${index}-${spellName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: spellName,
        school,
        categories,
        pips,
        image
      });
    });
  });

  Object.entries(fusionRecipes).forEach(([school, recipes]) => {
    recipes.filter(
      (recipe) =>
        recipe &&
        typeof recipe.result === "string" &&
        recipe.result.trim() &&
        Array.isArray(recipe.requires)
    ).forEach((recipe, index) => {
      const alreadyExists = cards.some(
        (card) =>
          card.school === school &&
          normalizeText(card.name) === normalizeText(recipe.result)
      );

      if (alreadyExists) return;

      const categories = inferSpellCategories({
        name: recipe.result
      });

      cards.push({
        id: `fusion-${school.toLowerCase()}-${index}-${normalizeText(recipe.result)}`,
        name: recipe.result,
        school,
        categories,
        pips: 0,
        image: buildLocalSpellImageUrl(school, recipe.result)
      });
    });
  });

  return cards;
}

function buildExtraDeckCardCatalog() {
  const cards = [];

  Object.entries(offlineSchoolSpellNamesExtraDeck).forEach(([school, spellEntries]) => {
    spellEntries.forEach((entry, index) => {
      const spell = typeof entry === "string" ? { name: entry } : entry;
      const spellName = String(spell.name || "Unknown Spell");
      const categories = Array.isArray(spell.categories)
        ? spell.categories
        : inferSpellCategories({ name: spellName });
      const pips = Number(spell.pips ?? 0);
      const localImage = buildLocalSpellImageUrl(school, spellName, "Extra deck");
      const image = localImage || spell.image || getFallbackCardImage({
        name: spellName,
        school,
        type: categories[0] || "Other",
        pips
      });

      cards.push({
        id: `extra-${school.toLowerCase()}-${index}-${normalizeText(spellName)}`,
        name: spellName,
        school,
        categories,
        pips,
        image
      });
    });
  });

  return cards;
}

function buildTreasureDeckCardCatalog() {
  const cards = [];

  Object.entries(offlineSchoolSpellNamesTreasureCards).forEach(([school, spellEntries]) => {
    spellEntries.forEach((entry, index) => {
      const spell = typeof entry === "string" ? { name: entry } : entry;
      const spellName = String(spell.name || "Unknown Spell");
      const categories = Array.isArray(spell.categories)
        ? spell.categories
        : inferSpellCategories({ name: spellName });
      const pips = Number(spell.pips ?? 0);
      const localImage = buildLocalSpellImageUrl(school, spellName, "TCs");
      const image = localImage || spell.image || getFallbackCardImage({
        name: spellName,
        school,
        type: categories[0] || "Other",
        pips
      });

      cards.push({
        id: `treasure-${school.toLowerCase()}-${index}-${normalizeText(spellName)}`,
        name: spellName,
        school,
        categories,
        pips,
        image
      });
    });
  });

  return cards;
}

function getCardCatalogForDeck(deckId) {
  if (deckId === "extra") return extraDeckCards;
  if (deckId === "treasure") return treasureDeckCards;
  return sampleCards;
}

function loadSpellCatalog() {
  try {
    sampleCards = buildOfflineCardCatalog();
    extraDeckCards = buildExtraDeckCardCatalog();
    treasureDeckCards = buildTreasureDeckCardCatalog();
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
  chatReply: null,
  importDialog: null,
  aboutOpen: false,
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

function getPlayerSectionsCollection() {
  return collection(db, "raids", raidId, "playerSections");
}

function findPlayerById(playerId) {
  const team = getTeamByPlayerId(playerId);
  const player = team?.players.find((entry) => entry.id === playerId);
  return team && player ? { team, player } : null;
}

async function saveStateToFirebase({ forceStructure = false } = {}) {
  if (!firebaseReady || !currentUser || applyingRemoteState) {
    return;
  }

  const generationBeingSaved = pendingSaveGeneration;
  const structureBeingSaved = forceStructure || pendingStructureSave;
  const raidNameBeingSaved = forceStructure || pendingRaidNameSave;
  const playerIdsBeingSaved = [...pendingPlayerIds];

  try {
    setSaveStatus("Syncing…");

    const updatedBy = {
      uid: currentUser.uid,
      name: participantName
    };
    const writes = [];

    if (structureBeingSaved || raidNameBeingSaved) {
      const raidUpdate = {
        updatedAt: serverTimestamp(),
        updatedBy
      };

      if (raidNameBeingSaved) raidUpdate.raidName = state.raidName;
      if (structureBeingSaved) raidUpdate.teams = state.teams;

      writes.push(setDoc(raidDocument, raidUpdate, { merge: true }));
    }

    playerIdsBeingSaved.forEach((playerId) => {
      const section = findPlayerById(playerId);
      if (!section) return;

      writes.push(setDoc(
        doc(getPlayerSectionsCollection(), playerId),
        {
          teamId: section.team.id,
          player: section.player,
          updatedAt: serverTimestamp(),
          updatedBy
        },
        { merge: true }
      ));
    });

    if (!writes.length && forceStructure) {
      writes.push(setDoc(
        raidDocument,
        {
          raidName: state.raidName,
          teams: state.teams,
          updatedAt: serverTimestamp(),
          updatedBy
        },
        { merge: true }
      ));
    }

    await Promise.all(writes);

    if (generationBeingSaved === pendingSaveGeneration) {
      hasPendingPlannerChanges = false;
      pendingStructureSave = false;
      pendingRaidNameSave = false;
      pendingPlayerIds.clear();
      scheduleLiveStatus();
    } else {
      postponePendingSave();
    }

  } catch (error) {
    console.error("Firebase save failed:", error);
    setSaveStatus("Save failed");
  }
}

function scheduleSave({ playerId = null, raidName = false, structure = false } = {}) {
  if (!firebaseReady || applyingRemoteState) {
    return;
  }

  if (playerId) pendingPlayerIds.add(playerId);
  if (raidName) pendingRaidNameSave = true;
  if (structure || (!playerId && !raidName)) pendingStructureSave = true;

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
  }, 1000);
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
  scheduleSave({ playerId });
}

function updatePlayerSchool(playerId, school) {
  const team = getTeamByPlayerId(playerId);
  if (!team) return;

  team.players = team.players.map((player) =>
    player.id === playerId ? { ...player, school } : player
  );
  render();
  scheduleSave({ playerId });
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
  scheduleSave({ playerId });
}

function addCardToPlayer(card) {
  if (isFusionSpell(card)) {
    console.warn(
      `Fusion-only spell "${card.name}" cannot be manually added.`
    );

    return;
  }

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
  scheduleSave({ playerId: state.selectedPlayerId });
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
                  <img class="spell-image" src="${card.image}" loading="lazy" decoding="async" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${escapeHtml(getCardCategoryLabel(card))}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
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

function renderPlayerColumn(team, player) {
  return `
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
  `;
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
        ${team.players.map((player) => renderPlayerColumn(team, player)).join("")}
      </div>
    </section>
  `;
}

function bindPlayerColumnEvents(root = document) {
  root.querySelectorAll("[data-player-name]").forEach((element) => {
    element.addEventListener("input", (event) => {
      const playerId = element.getAttribute("data-player-name");
      updatePlayerName(playerId, event.target.value);
    });
  });

  root.querySelectorAll("[data-cycle-school]").forEach((element) => {
    element.addEventListener("click", () => {
      cyclePlayerSchool(element.getAttribute("data-cycle-school"));
    });
  });

  root.querySelectorAll("[data-remove-player]").forEach((element) => {
    element.addEventListener("click", () => {
      const [teamId, playerId] = element.getAttribute("data-remove-player").split("|");
      removePlayerFromTeam(teamId, playerId);
    });
  });

  root.querySelectorAll("[data-open-picker-player]").forEach((element) => {
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

  root.querySelectorAll("[data-toggle-deck]").forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, deckId] = element.getAttribute("data-toggle-deck").split("|");
      const key = deckExpansionKey(playerId, deckId);
      state.expandedDecks[key] = !isDeckExpanded(playerId, deckId);
      render();
    });
  });

  root.querySelectorAll("img.spell-image").forEach((img) => {
    img.addEventListener("error", (event) => {
      const cardName = (img.dataset.cardName || "Unknown spell").replace(/&amp;/g, "&");
      handleImageFailure(event, {
        name: cardName,
        school: img.dataset.cardSchool || "Balance",
        type: img.dataset.cardType || "Utility",
        pips: Number(img.dataset.cardPips || 0)
      });
    });
  });

  root.querySelectorAll("[data-card-quantity]").forEach((element) => {
    element.addEventListener("click", () => {
      const [playerId, deckId, cardId, change] = element.getAttribute("data-card-quantity").split("|");
      changeCardQuantity(playerId, deckId, cardId, Number(change));
    });
  });
}

function refreshPlayerColumn(playerId) {
  const section = findPlayerById(playerId);
  const currentColumn = document.querySelector(`[data-player-card="${CSS.escape(playerId)}"]`);
  if (!section || !currentColumn) return false;

  const template = document.createElement("template");
  template.innerHTML = renderPlayerColumn(section.team, section.player).trim();
  const nextColumn = template.content.firstElementChild;
  currentColumn.replaceWith(nextColumn);
  bindPlayerColumnEvents(nextColumn);
  return true;
}

function render() {
  const previousMain = document.querySelector(".main");
  const previousScrollTop = previousMain?.scrollTop || 0;

  const normalizedQuery = normalizeText(state.query);
  const activeCardCatalog = getCardCatalogForDeck(state.selectedDeckId);

  const filteredCards = activeCardCatalog.filter((card) => {
    const categories = getCardCategories(card);

    const matchesQuery =
      !normalizedQuery ||
      normalizeText(card.name).includes(normalizedQuery) ||
      normalizeText(card.school).includes(normalizedQuery) ||
      categories.some((category) =>
        normalizeText(category).includes(normalizedQuery)
      );

    const matchesSchool =
      state.school === "All" ||
      card.school === state.school;

    const matchesType =
      state.type === "All" ||
      categories.includes(state.type);

    return (
      !isFusionSpell(card) &&
      matchesQuery &&
      matchesSchool &&
      matchesType
    );
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
          <button class="secondary import-decks-btn" id="import-decks-btn">⇩ Import decks</button>
          <button class="secondary about-btn" id="about-btn">ⓘ About</button>
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
      
      <div class="chat-drawer ${state.chatOpen ? "open" : ""}">
        <button
          class="chat-toggle"
          id="chat-toggle-btn"
          type="button"
          aria-controls="chat-panel"
          aria-expanded="${state.chatOpen}"
          aria-label="${state.chatOpen ? "Collapse chat" : "Expand chat"}"
        >
          <span aria-hidden="true">${state.chatOpen ? "›" : "‹"}</span>
          <strong>Chat</strong>
          ${unreadMessageCount > 0 ? `
            <span class="chat-unread-badge" aria-label="${unreadMessageCount} unread messages">
              ${unreadMessageCount > 99 ? "99+" : unreadMessageCount}
            </span>
          ` : ""}
        </button>

        <aside
          class="chat-panel"
          id="chat-panel"
          aria-hidden="${!state.chatOpen}"
          ${state.chatOpen ? "" : "inert"}
        >
          <div class="chat-header">
            <div>
              <div class="eyebrow">LIVE DISCUSSION</div>
              <strong id="chat-user-name">${escapeHtml(participantName)}</strong>
            </div>

            <button class="icon-btn" id="close-chat-btn" aria-label="Collapse chat">✕</button>
          </div>

          <div id="chat-messages" class="chat-messages"></div>

          <div id="chat-reply-preview" class="chat-reply-preview ${state.chatReply ? "" : "hidden"}">
            <div>
              <span>Replying to ${escapeHtml(state.chatReply?.authorName || "")}</span>
              <p>${escapeHtml(state.chatReply?.text || "")}</p>
            </div>
            <button type="button" id="cancel-chat-reply" aria-label="Cancel reply">✕</button>
          </div>

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
        </aside>
      </div>

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
                  ${cardLibrarySchools.map((school) => `
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
                    <img class="library-image" src="${card.image}" loading="lazy" decoding="async" data-original-src="${card.image}" data-card-name="${escapeHtml(card.name)}" data-card-school="${card.school}" data-card-type="${escapeHtml(getCardCategoryLabel(card))}" data-card-pips="${card.pips || 0}" alt="${escapeHtml(card.name)}" />
                  </div>
                  <div class="library-info">
                    <strong>${escapeHtml(card.name)}</strong>
                    <span>${escapeHtml(card.school)} · ${escapeHtml(getCardCategoryLabel(card))}</span>
                  </div>
                </button>
              `).join("") : '<div class="no-results">No spells match your filters.</div>'}
            </div>
          </div>
        </div>
      ` : ""}

      ${state.importDialog ? `
        <div class="modal-backdrop" id="import-backdrop">
          <div class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <div class="picker-header">
              <div>
                <div class="eyebrow">PREVIOUS RAID</div>
                <h2 id="import-title">Import player decks</h2>
              </div>
              <button class="icon-btn" id="close-import-btn" aria-label="Close import">✕</button>
            </div>

            <p class="import-description">
              Select the matching players whose Main, Extra, and Treasure Card decks should be copied.
            </p>

            <form id="import-decks-form">
              <div class="import-player-list">
                ${state.importDialog.choices.length
                  ? state.importDialog.choices.map((choice) => `
                    <label class="import-player-option">
                      <input type="checkbox" name="import-player" value="${choice.targetPlayerId}" checked />
                      <span>
                        <strong>${escapeHtml(choice.targetPlayerName)}</strong>
                        <small>${escapeHtml(choice.targetTeamName)} · matched from previous raid</small>
                      </span>
                    </label>
                  `).join("")
                  : '<div class="no-import-matches">No players in this raid have the same name as players in the previous raid.</div>'
                }
              </div>

              <div class="import-actions">
                <button type="button" class="secondary" id="cancel-import-btn">Cancel</button>
                <button type="submit" class="primary" ${state.importDialog.choices.length ? "" : "disabled"}>
                  Import selected
                </button>
              </div>
            </form>
          </div>
        </div>
      ` : ""}

      ${state.aboutOpen ? `
        <div class="about-page" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <header class="about-header">
            <div>
              <div class="eyebrow">WIZARD101 RAID PLANNER</div>
              <h2 id="about-title">About &amp; beginner guide</h2>
            </div>
            <button class="secondary" id="close-about-btn">← Back to planner</button>
          </header>

          <main class="about-content">
            <section class="about-hero">
              <div>
                <span class="about-kicker">START HERE</span>
                <h3>Plan a raid together, one deck at a time.</h3>
                <p>
                  This planner is a shared room where your group can prepare teams, players and spell decks.
                  Everyone who opens the same raid link sees the same plan and can work on it together.
                  You do not need an account: enter a display name when the page opens and you are ready.
                </p>
              </div>
              <ol class="about-steps">
                <li><strong>Open a raid link.</strong><span>Enter the name your group will recognize.</span></li>
                <li><strong>Find your player.</strong><span>Choose a school and type the wizard name.</span></li>
                <li><strong>Build the decks.</strong><span>Expand a deck, add cards and set their quantities.</span></li>
                <li><strong>Talk with the team.</strong><span>Use Chat to coordinate changes in real time.</span></li>
              </ol>
            </section>

            <nav class="about-nav" aria-label="Guide sections">
              <a href="#guide-layout">Planner layout</a>
              <a href="#guide-decks">The four decks</a>
              <a href="#guide-cards">Managing cards</a>
              <a href="#guide-chat">Chat</a>
              <a href="#guide-links">Links &amp; import</a>
              <a href="#guide-saving">Saving</a>
            </nav>

            <section class="about-section" id="guide-layout">
              <div class="about-section-heading">
                <span>01</span>
                <div><h3>Understanding the planner</h3><p>The screen is divided into a few simple working areas.</p></div>
              </div>
              <div class="about-card-grid">
                <article class="about-card"><h4>Raid name</h4><p>The text box at the top names the current plan. Changing it does not change the raid link or create a new raid.</p></article>
                <article class="about-card"><h4>Teams</h4><p>The left sidebar lists every team. Select a team to work on it. Use <strong>＋</strong> to add another team, and drag team names to change their order.</p></article>
                <article class="about-card"><h4>Participants</h4><p>The bottom of the sidebar shows people who currently have this raid open. This is a presence list, not the list of wizards placed in teams.</p></article>
                <article class="about-card"><h4>Team View</h4><p>This is the main work area. Each team can contain up to four players. Add, rename or remove teams and players with the buttons beside them.</p></article>
                <article class="about-card"><h4>Player name and school</h4><p>Type directly in a player's name box. Select the round school icon to cycle through the available schools.</p></article>
                <article class="about-card"><h4>Live indicator</h4><p><strong>Editing…</strong> means a change is waiting to save, <strong>Syncing…</strong> means it is being sent, and the green <strong>Live</strong> status means the shared plan is up to date.</p></article>
              </div>
            </section>

            <section class="about-section" id="guide-decks">
              <div class="about-section-heading">
                <span>02</span>
                <div><h3>The four deck sections</h3><p>Every player has four separate card areas with different purposes.</p></div>
              </div>
              <div class="deck-guide-grid">
                <article class="deck-guide main-deck-guide">
                  <div class="deck-guide-number">1</div><h4>Main Deck</h4>
                  <p>The regular spells the player plans to carry and use during the raid. This is also the deck the Fusion Deck reads when checking fusion recipes.</p>
                </article>
                <article class="deck-guide extra-deck-guide">
                  <div class="deck-guide-number">2</div><h4>Extra Deck</h4>
                  <p>A separate collection for special Extra Deck spells. Its Add Card window only shows cards placed in each school's <strong>Extra deck</strong> folder.</p>
                </article>
                <article class="deck-guide fusion-deck-guide">
                  <div class="deck-guide-number">3</div><h4>Fusion Deck</h4>
                  <p>This deck is automatic, so it has no Add Card button. It examines the Main Deck and displays a fusion spell when all required ingredients are present.</p>
                  <div class="fusion-example"><span>Ammut</span><b>＋</b><span>Fire Dragon</span><b>→</b><strong>Ammut's Fury</strong></div>
                </article>
                <article class="deck-guide treasure-deck-guide">
                  <div class="deck-guide-number">4</div><h4>Treasure Card Deck</h4>
                  <p>The player's separate supply of Treasure Cards. Its picker only contains cards from the <strong>TCs</strong> folder for each school.</p>
                </article>
              </div>
              <div class="about-note"><strong>Expand or collapse:</strong> Select a deck's title bar to show or hide its cards. The number at the right of the bar is the total number of card copies in that deck.</div>
            </section>

            <section class="about-section" id="guide-cards">
              <div class="about-section-heading">
                <span>03</span>
                <div><h3>Adding and managing cards</h3><p>Cards of the same name are grouped together instead of filling the screen with duplicates.</p></div>
              </div>
              <div class="about-instructions">
                <div><b>1</b><p>Expand Main, Extra or Treasure Card Deck and select <strong>＋ Add Card</strong>.</p></div>
                <div><b>2</b><p>Search by spell name, or narrow the list with the <strong>School</strong> and <strong>Type</strong> menus.</p></div>
                <div><b>3</b><p>Select a card to add one copy. Use <strong>＋</strong> beside the card to add more copies and <strong>−</strong> to remove them.</p></div>
                <div><b>4</b><p>The <strong>× number</strong> beside a card is its quantity. When the quantity reaches zero, the card disappears from that deck.</p></div>
              </div>
              <p class="about-small">Card types include buffs and debuffs, shields, traps, field spells, damage over time, area-of-effect attacks, single-target attacks and heals.</p>
            </section>

            <section class="about-section" id="guide-chat">
              <div class="about-section-heading">
                <span>04</span>
                <div><h3>Live chat</h3><p>The Chat tab on the right edge opens the shared discussion for this raid.</p></div>
              </div>
              <div class="chat-guide-layout">
                <div class="chat-example" aria-label="Example chat conversation">
                  <div class="example-message other"><strong>Simon</strong><p>@Luca_Stellarshade Can you add two traps?</p></div>
                  <div class="example-message mine"><strong>Luca Stellarshade</strong><p>I added them to the Main Deck.</p></div>
                  <div class="example-caption">Example conversation</div>
                </div>
                <div class="about-card-grid compact">
                  <article class="about-card"><h4>Unread messages</h4><p>When Chat is closed, the red counter shows how many messages other people sent since you last opened it.</p></article>
                  <article class="about-card"><h4>Reply</h4><p>Right-click a message balloon to quote and reply to it. Select <strong>✕</strong> above the message box to cancel the reply.</p></article>
                  <article class="about-card"><h4>Mention someone</h4><p>Type <strong>@name</strong> to notify an active participant with a sound. Replace spaces with underscores: <strong>@Luca_Stellarshade</strong>.</p></article>
                  <article class="about-card"><h4>Clear the discussion</h4><p>Send <strong>/clear</strong> as the entire message. It hides everything before that command for everyone in the raid.</p></article>
                </div>
              </div>
            </section>

            <section class="about-section" id="guide-links">
              <div class="about-section-heading">
                <span>05</span>
                <div><h3>Raid links and deck import</h3><p>The raid ID inside the address tells the planner which shared room to open.</p></div>
              </div>
              <div class="link-guide">
                <article>
                  <h4>Copy raid link</h4>
                  <ol><li>Select <strong>Copy raid link</strong>.</li><li>Send the copied address to your teammates.</li><li>When they open it, they enter a display name and join the same plan.</li></ol>
                  <p>Do not remove or change the <strong>?raid=...</strong> part of the address. A link without that same raid ID opens a different session.</p>
                </article>
                <article>
                  <h4>Import decks from an older raid</h4>
                  <ol><li>Copy the link of the previous raid.</li><li>Open the new raid and create or rename its players so their names match the old players.</li><li>Select <strong>Import decks</strong> and paste the previous link.</li><li>Tick one or more matching players, then select <strong>Import selected</strong>.</li></ol>
                  <p>Matching ignores capital letters, but the player names otherwise need to be the same. Main, Extra and Treasure Card decks are copied. Fusion cards are recalculated automatically. The older raid is not changed.</p>
                </article>
              </div>
            </section>

            <section class="about-section" id="guide-saving">
              <div class="about-section-heading">
                <span>06</span>
                <div><h3>Automatic saving and collaboration</h3><p>There is no Save button because planner changes are saved automatically.</p></div>
              </div>
              <div class="about-card-grid compact">
                <article class="about-card"><h4>Automatic sync</h4><p>After you stop editing briefly, your changes are sent to Firebase. You can continue planning while this happens.</p></article>
                <article class="about-card"><h4>Individual player updates</h4><p>Deck edits are synchronized for the affected player section, reducing unnecessary updates for teammates working elsewhere.</p></article>
                <article class="about-card"><h4>Returning later</h4><p>Use the same raid link to return to the saved plan. A different raid ID represents a different shared session.</p></article>
                <article class="about-card"><h4>If saving fails</h4><p>Check the internet connection and keep the page open. Avoid refreshing until the status reconnects and returns to <strong>Live</strong>.</p></article>
              </div>
            </section>

            <section class="about-finish">
              <div><span class="about-kicker">READY TO PLAN</span><h3>Return to your raid and build the team.</h3></div>
              <button class="primary" id="finish-about-btn">Back to planner</button>
            </section>
          </main>
        </div>
      ` : ""}
    </div>
  `;

  document.getElementById("raid-name-input")?.addEventListener("input", (event) => {
    state.raidName = event.target.value;
    scheduleSave({ raidName: true });
  });

  document.getElementById("copy-link-btn")?.addEventListener("click", copyRaidLink);
  document.getElementById("import-decks-btn")?.addEventListener("click", beginDeckImport);
  document.getElementById("about-btn")?.addEventListener("click", () => {
    state.aboutOpen = true;
    render();
  });
  const closeAboutPage = () => {
    state.aboutOpen = false;
    render();
  };
  document.getElementById("close-about-btn")?.addEventListener("click", closeAboutPage);
  document.getElementById("finish-about-btn")?.addEventListener("click", closeAboutPage);
  document.getElementById("chat-toggle-btn")?.addEventListener("click", () => {
    state.chatOpen = !state.chatOpen;
    if (state.chatOpen) markChatAsSeen();
    render();
  });
  document.getElementById("close-chat-btn")?.addEventListener("click", () => {
    state.chatOpen = false;
    render();
  });
  document.getElementById("cancel-chat-reply")?.addEventListener("click", () => {
    state.chatReply = null;
    renderChatReplyPreview();
    document.getElementById("chat-input")?.focus();
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

  const closeImportDialog = () => {
    state.importDialog = null;
    render();
  };
  document.getElementById("close-import-btn")?.addEventListener("click", closeImportDialog);
  document.getElementById("cancel-import-btn")?.addEventListener("click", closeImportDialog);
  document.getElementById("import-backdrop")?.addEventListener("click", (event) => {
    if (event.target.id === "import-backdrop") closeImportDialog();
  });
  document.getElementById("import-decks-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const selectedPlayerIds = [...event.currentTarget.querySelectorAll(
      'input[name="import-player"]:checked'
    )].map((input) => input.value);
    importSelectedDecks(selectedPlayerIds);
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

  document.querySelectorAll("img.library-image")?.forEach((img) => {
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
      const activeCardCatalog = getCardCatalogForDeck(state.selectedDeckId);
      const card = activeCardCatalog.find((entry) => entry.id === cardId);
      if (card) addCardToPlayer(card);
    });
  });

  bindPlayerColumnEvents(document);

  document.getElementById("chat-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const input = document.getElementById("chat-input");
    if (!input) return;

    const message = input.value;
    input.value = "";
    state.chatDraft = "";

    try {
      await sendChatMessage(message);
      state.chatReply = null;
      renderChatReplyPreview();
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

  requestAnimationFrame(() => {
    const nextMain = document.querySelector(".main");

    if (nextMain) {
      nextMain.scrollTop = previousScrollTop;
    }
  });
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
document.addEventListener("pointerdown", unlockChatAudio, { capture: true, once: true });
document.addEventListener("keydown", unlockChatAudio, { capture: true, once: true });

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

function extractRaidId(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";

  try {
    const url = new URL(trimmed);
    return url.searchParams.get("raid")?.trim() || "";
  } catch {
    return /^[a-zA-Z0-9_-]+$/.test(trimmed) ? trimmed : "";
  }
}

function normalizePlayerNameForMatch(value) {
  return String(value || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

async function loadPreviousRaidPlayers(sourceRaidId) {
  const sourceRaidReference = doc(db, "raids", sourceRaidId);
  const sourceRaidSnapshot = await getDoc(sourceRaidReference);
  if (!sourceRaidSnapshot.exists()) {
    throw new Error("The previous raid could not be found.");
  }

  const sourceRaid = sourceRaidSnapshot.data();
  const sourceTeams = Array.isArray(sourceRaid.teams)
    ? normalizeSavedTeams(sourceRaid.teams)
    : [];
  const sectionSnapshot = await getDocs(
    collection(db, "raids", sourceRaidId, "playerSections")
  );
  const sourceSections = new Map(
    sectionSnapshot.docs.map((sectionDocument) => [
      sectionDocument.id,
      sectionDocument.data().player
    ])
  );

  return sourceTeams.flatMap((team) =>
    team.players.map((player) =>
      sourceSections.has(player.id)
        ? normalizePlayerDecks(sourceSections.get(player.id))
        : player
    )
  );
}

async function beginDeckImport() {
  const sourceValue = window.prompt(
    "Paste the raid link from the previous session:"
  );
  if (sourceValue === null) return;

  const sourceRaidId = extractRaidId(sourceValue);
  if (!sourceRaidId) {
    window.alert("That is not a valid raid link.");
    return;
  }
  if (sourceRaidId === raidId) {
    window.alert("Choose a different raid. This is the current raid.");
    return;
  }

  const button = document.getElementById("import-decks-btn");
  if (button) {
    button.disabled = true;
    button.textContent = "Loading…";
  }

  try {
    const sourcePlayers = await loadPreviousRaidPlayers(sourceRaidId);
    const sourcePlayersByName = new Map();

    sourcePlayers.forEach((player) => {
      const key = normalizePlayerNameForMatch(player.name);
      if (key && !sourcePlayersByName.has(key)) {
        sourcePlayersByName.set(key, player);
      }
    });

    const choices = state.teams.flatMap((team) =>
      team.players
        .map((targetPlayer) => ({
          targetPlayerId: targetPlayer.id,
          targetPlayerName: targetPlayer.name,
          targetTeamName: team.name,
          sourcePlayer: sourcePlayersByName.get(
            normalizePlayerNameForMatch(targetPlayer.name)
          )
        }))
        .filter((choice) => Boolean(choice.sourcePlayer))
    );

    state.importDialog = {
      sourceRaidId,
      choices
    };
    render();
  } catch (error) {
    console.error("Deck import failed:", error);
    window.alert(error.message || "The previous raid could not be loaded.");
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "⇩ Import decks";
    }
  }
}

function cloneImportedDecks(sourcePlayer) {
  const sourceDecks = normalizePlayerDecks(sourcePlayer).decks;
  const cloneEntries = (entries) =>
    JSON.parse(JSON.stringify(Array.isArray(entries) ? entries : []));

  return {
    main: cloneEntries(sourceDecks.main),
    extra: cloneEntries(sourceDecks.extra),
    fusion: [],
    treasure: cloneEntries(sourceDecks.treasure)
  };
}

function importSelectedDecks(selectedPlayerIds) {
  const importDialog = state.importDialog;
  if (!importDialog) return;

  const selectedIds = new Set(selectedPlayerIds);
  const selectedChoices = importDialog.choices.filter((choice) =>
    selectedIds.has(choice.targetPlayerId)
  );
  if (!selectedChoices.length) {
    window.alert("Select at least one matching player.");
    return;
  }

  const choicesByPlayerId = new Map(
    selectedChoices.map((choice) => [choice.targetPlayerId, choice])
  );

  state.teams = state.teams.map((team) => ({
    ...team,
    players: team.players.map((player) => {
      const choice = choicesByPlayerId.get(player.id);
      return choice
        ? { ...player, decks: cloneImportedDecks(choice.sourcePlayer) }
        : player;
    })
  }));

  state.importDialog = null;
  render();
  selectedChoices.forEach((choice) =>
    scheduleSave({ playerId: choice.targetPlayerId })
  );
  window.alert(
    `Imported decks for ${selectedChoices.length} player${selectedChoices.length === 1 ? "" : "s"}.`
  );
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

function getOnlineParticipants() {
  const onlineLimit = Date.now() - 45000;
  return allParticipants.filter((participant) => {
    if (participant.uid === currentUser?.uid) {
      return true;
    }

    const lastSeen = participant.lastSeen?.toMillis?.();

    return typeof lastSeen === "number" && lastSeen >= onlineLimit;
  });
}

function renderParticipants() {
  const list = document.getElementById("participant-list");
  if (!list) return;

  const onlineParticipants = getOnlineParticipants();

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

function unlockChatAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;

  if (!chatAudioContext) chatAudioContext = new AudioContextClass();
  if (chatAudioContext.state === "suspended") {
    chatAudioContext.resume().catch(() => {});
  }
}

function playMentionPing() {
  unlockChatAudio();
  if (!chatAudioContext || chatAudioContext.state !== "running") return;

  const now = chatAudioContext.currentTime;
  const gain = chatAudioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  gain.connect(chatAudioContext.destination);

  [880, 1175].forEach((frequency, index) => {
    const oscillator = chatAudioContext.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(gain);
    oscillator.start(now + (index * 0.1));
    oscillator.stop(now + 0.22 + (index * 0.1));
  });
}

function getMentionedParticipantIds(text) {
  const mentionAliases = new Set(
    [...String(text).matchAll(/@([a-zA-Z0-9_]+)/g)]
      .map((match) => match[1].toLocaleLowerCase())
  );
  if (!mentionAliases.size) return [];

  return getOnlineParticipants()
    .filter((participant) => {
      const alias = String(participant.name || "")
        .trim()
        .toLocaleLowerCase()
        .replace(/\s+/g, "_");
      return mentionAliases.has(alias);
    })
    .map((participant) => participant.uid)
    .filter((uid) => uid && uid !== currentUser?.uid);
}

async function sendChatMessage(text) {
  const normalizedText = text.trim();
  if (!currentUser || !normalizedText) return;

  const isClearCommand = normalizedText.toLocaleLowerCase() === "/clear";
  const recipientIds = isClearCommand
    ? []
    : getMentionedParticipantIds(normalizedText);

  if (
    !isClearCommand &&
    state.chatReply?.authorId &&
    state.chatReply.authorId !== currentUser.uid
  ) {
    recipientIds.push(state.chatReply.authorId);
  }

  const message = {
    type: isClearCommand ? "clear" : "message",
    text: normalizedText.slice(0, 500),
    authorId: currentUser.uid,
    authorName: participantName,
    recipientIds: [...new Set(recipientIds)],
    createdAt: serverTimestamp()
  };

  if (!isClearCommand && state.chatReply) {
    message.replyTo = {
      messageId: state.chatReply.messageId,
      authorId: state.chatReply.authorId,
      authorName: state.chatReply.authorName,
      text: state.chatReply.text.slice(0, 160)
    };
  }

  await addDoc(getMessagesCollection(), message);
}

function chatLastSeenStorageKey() {
  return `wizard101-chat-last-seen-${raidId}-${currentUser?.uid || "guest"}`;
}

function getMessagesAfterLastClear(messages) {
  let lastClearIndex = -1;
  messages.forEach((message, index) => {
    if (
      message.type === "clear" ||
      String(message.text || "").trim().toLocaleLowerCase() === "/clear"
    ) {
      lastClearIndex = index;
    }
  });
  return lastClearIndex >= 0 ? messages.slice(lastClearIndex) : messages;
}

function updateChatUnreadBadge() {
  const button = document.getElementById("chat-toggle-btn");
  if (!button) return;

  let badge = button.querySelector(".chat-unread-badge");
  if (unreadMessageCount <= 0) {
    badge?.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement("span");
    badge.className = "chat-unread-badge";
    button.appendChild(badge);
  }
  badge.textContent = unreadMessageCount > 99 ? "99+" : String(unreadMessageCount);
  badge.setAttribute("aria-label", `${unreadMessageCount} unread messages`);
}

function markChatAsSeen() {
  const visibleMessages = getMessagesAfterLastClear(latestMessages);
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  if (lastMessage && currentUser) {
    localStorage.setItem(chatLastSeenStorageKey(), lastMessage.id);
  }
  unreadMessageCount = 0;
  updateChatUnreadBadge();
}

function calculateUnreadMessages() {
  if (state.chatOpen) {
    markChatAsSeen();
    return;
  }

  const visibleMessages = getMessagesAfterLastClear(latestMessages);
  const lastSeenMessageId = currentUser
    ? localStorage.getItem(chatLastSeenStorageKey())
    : "";

  if (!messagesInitialized && !lastSeenMessageId) {
    const lastMessage = visibleMessages[visibleMessages.length - 1];
    if (lastMessage && currentUser) {
      localStorage.setItem(chatLastSeenStorageKey(), lastMessage.id);
    }
    unreadMessageCount = 0;
    return;
  }

  const lastSeenIndex = visibleMessages.findIndex(
    (message) => message.id === lastSeenMessageId
  );
  const messagesSinceLastSeen = lastSeenIndex >= 0
    ? visibleMessages.slice(lastSeenIndex + 1)
    : visibleMessages;

  unreadMessageCount = messagesSinceLastSeen.filter((message) =>
    message.type !== "clear" && message.authorId !== currentUser?.uid
  ).length;
  updateChatUnreadBadge();
}

function subscribeToMessages() {
  if (unsubscribeMessages) unsubscribeMessages();

  const messagesQuery = query(
    getMessagesCollection(),
    orderBy("createdAt", "desc"),
    limit(100)
  );

  unsubscribeMessages = onSnapshot(
    messagesQuery,
    (snapshot) => {
      const addedMessages = snapshot.docChanges()
        .filter((change) => change.type === "added")
        .map((change) => ({ id: change.doc.id, ...change.doc.data() }));

      latestMessages = snapshot.docs
        .map((messageDocument) => ({
          id: messageDocument.id,
          ...messageDocument.data()
        }))
        .reverse();

      if (messagesInitialized && currentUser) {
        const pinged = addedMessages.some((message) =>
          message.authorId !== currentUser.uid &&
          (
            message.recipientIds?.includes?.(currentUser.uid) ||
            message.replyTo?.authorId === currentUser.uid
          )
        );
        if (pinged) playMentionPing();
      }

      calculateUnreadMessages();
      renderMessages(latestMessages);
      messagesInitialized = true;
    },
    (error) => {
      console.error("Chat listener failed:", error);
    }
  );
}

function getChatParticipantColor(identity) {
  let hash = 0;
  const value = String(identity || "anonymous");

  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
  }

  const hue = hash % 360;
  return {
    accent: `hsl(${hue} 85% 75%)`,
    background: `hsl(${hue} 65% 35% / 0.34)`
  };
}

function renderMessages(messages) {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const visibleMessages = getMessagesAfterLastClear(messages);

  container.innerHTML = visibleMessages
    .map((message) => {
      if (message.type === "clear" || String(message.text || "").trim().toLocaleLowerCase() === "/clear") {
        return `
          <div class="chat-clear-marker">
            Chat cleared by ${escapeHtml(message.authorName || "Anonymous")}
          </div>
        `;
      }

      const mine = message.authorId === currentUser?.uid;
      const color = getChatParticipantColor(message.authorId || message.authorName);

      return `
        <div
          class="chat-message ${mine ? "mine" : ""}"
          data-message-id="${message.id}"
          style="--participant-color:${color.accent}; --participant-background:${color.background};"
        >
          ${message.replyTo ? `
            <div class="chat-reply-quote">
              <strong>${escapeHtml(message.replyTo.authorName || "Anonymous")}</strong>
              <span>${escapeHtml(message.replyTo.text || "")}</span>
            </div>
          ` : ""}
          <strong>${escapeHtml(message.authorName || "Anonymous")}</strong>
          <p>${escapeHtml(message.text || "")}</p>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll("[data-message-id]").forEach((messageElement) => {
    messageElement.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      const message = visibleMessages.find(
        (entry) => entry.id === messageElement.dataset.messageId
      );
      if (!message) return;

      state.chatReply = {
        messageId: message.id,
        authorId: message.authorId,
        authorName: message.authorName || "Anonymous",
        text: message.text || ""
      };
      renderChatReplyPreview();
      document.getElementById("chat-input")?.focus();
    });
  });

  if (state.chatOpen) markChatAsSeen();
  container.scrollTop = container.scrollHeight;
}

function renderChatReplyPreview() {
  const preview = document.getElementById("chat-reply-preview");
  if (!preview) return;

  if (!state.chatReply) {
    preview.classList.add("hidden");
    return;
  }

  preview.classList.remove("hidden");
  preview.querySelector("span").textContent = `Replying to ${state.chatReply.authorName}`;
  preview.querySelector("p").textContent = state.chatReply.text;
}

function normalizeSavedTeams(teams) {
  return teams.map((team) => ({
    ...team,
    players: team.players.map(normalizePlayerDecks)
  }));
}

function overlayPlayerSections(teams) {
  return teams.map((team) => ({
    ...team,
    players: team.players.map((player) => {
      if (pendingPlayerIds.has(player.id)) {
        return findPlayerById(player.id)?.player || player;
      }

      const section = latestPlayerSections.get(player.id);
      return section?.player ? normalizePlayerDecks(section.player) : player;
    })
  }));
}

function subscribeToPlayerSections() {
  if (unsubscribePlayerSections) unsubscribePlayerSections();

  unsubscribePlayerSections = onSnapshot(
    getPlayerSectionsCollection(),
    (snapshot) => {
      const changedPlayerIds = new Set();

      snapshot.docChanges().forEach((change) => {
        if (change.type === "removed") {
          latestPlayerSections.delete(change.doc.id);
          return;
        }

        const section = change.doc.data();
        latestPlayerSections.set(change.doc.id, section);

        if (pendingPlayerIds.has(change.doc.id)) return;

        const current = findPlayerById(change.doc.id);
        if (!current || !section.player) return;

        const nextPlayer = normalizePlayerDecks(section.player);
        if (JSON.stringify(current.player) === JSON.stringify(nextPlayer)) return;

        current.team.players = current.team.players.map((player) =>
          player.id === change.doc.id ? nextPlayer : player
        );
        changedPlayerIds.add(change.doc.id);
      });

      if (!changedPlayerIds.size) return;

      applyingRemoteState = true;
      changedPlayerIds.forEach((playerId) => {
        if (!refreshPlayerColumn(playerId)) render();
      });
      applyingRemoteState = false;
      markChanged();
      scheduleLiveStatus();
    },
    (error) => {
      console.error("Player section listener failed:", error);
      setSaveStatus("Connection failed");
    }
  );
}


function subscribeToRaid() {
  if (unsubscribeRaid) {
    unsubscribeRaid();
  }

  unsubscribeRaid = onSnapshot(
    raidDocument,
    async (snapshot) => {
      if (!snapshot.exists()) {
        pendingStructureSave = true;
        pendingRaidNameSave = true;
        await saveStateToFirebase({ forceStructure: true });
        return;
      }

      const savedRaid = snapshot.data();
      const nextRaidName = pendingRaidNameSave
        ? state.raidName
        : typeof savedRaid.raidName === "string"
          ? savedRaid.raidName
          : state.raidName;
      const nextTeams = pendingStructureSave || !Array.isArray(savedRaid.teams) || !savedRaid.teams.length
        ? state.teams
        : overlayPlayerSections(normalizeSavedTeams(savedRaid.teams));
      const raidChanged = nextRaidName !== state.raidName;
      const teamsChanged = JSON.stringify(nextTeams) !== JSON.stringify(state.teams);

      if (!raidChanged && !teamsChanged) {
        scheduleLiveStatus();
        return;
      }

      applyingRemoteState = true;
      state.raidName = nextRaidName;
      state.teams = nextTeams;

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
