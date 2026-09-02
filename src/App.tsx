import { useMemo, useState } from "react";
import { Plus, Search, Save, Trash2, X } from "lucide-react";
import { cardTypes, schools, sampleCards, starterPlayers, starterRounds } from "./data";
import type { Card, Player, Round, School } from "./types";

const emoji: Record<School, string> = {
  Storm: "⚡", Fire: "🔥", Ice: "❄️", Life: "🌿", Death: "💀", Myth: "🗿", Balance: "⚖️"
};

export default function App() {
  const [raidName, setRaidName] = useState("New Raid");
  const [players, setPlayers] = useState<Player[]>(starterPlayers);
  const [rounds, setRounds] = useState<Round[]>(starterRounds);
  const [activeRound, setActiveRound] = useState("r1");
  const [selectedPlayer, setSelectedPlayer] = useState("p1");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [school, setSchool] = useState<(typeof schools)[number]>("All");
  const [type, setType] = useState<(typeof cardTypes)[number]>("All");

  const currentRound = rounds.find(r => r.id === activeRound)!;

  const filteredCards = useMemo(() => sampleCards.filter(card =>
    card.name.toLowerCase().includes(query.toLowerCase()) &&
    (school === "All" || card.school === school) &&
    (type === "All" || card.type === type)
  ), [query, school, type]);

  const addPlayer = () => {
    const id = `p${Date.now()}`;
    setPlayers(p => [...p, { id, name: `Player ${p.length + 1}`, school: "Storm" }]);
  };

  const removePlayer = (id: string) => {
    setPlayers(p => p.filter(x => x.id !== id));
    setRounds(rs => rs.map(r => ({ ...r, assignments: r.assignments.filter(a => a.playerId !== id) })));
  };

  const addRound = () => {
    const id = `r${Date.now()}`;
    setRounds(rs => [...rs, { id, name: `Round ${rs.length + 1}`, assignments: [] }]);
    setActiveRound(id);
  };

  const addCard = (card: Card) => {
    setRounds(rs => rs.map(r => r.id === activeRound
      ? { ...r, assignments: [...r.assignments, { playerId: selectedPlayer, cardId: card.id }] }
      : r
    ));
    setPickerOpen(false);
  };

  const removeAssignment = (index: number) => {
    setRounds(rs => rs.map(r => r.id === activeRound
      ? { ...r, assignments: r.assignments.filter((_, i) => i !== index) }
      : r
    ));
  };

  const save = () => {
    localStorage.setItem("wizard101-raid-planner", JSON.stringify({ raidName, players, rounds }));
    window.alert("Raid plan saved locally in this browser.");
  };

  const assignmentsFor = (playerId: string) =>
    currentRound.assignments.map((a, index) => ({ ...a, index })).filter(a => a.playerId === playerId);

  return (
    <div className="app">
      <header className="topbar">
        <div><div className="eyebrow">WIZARD101</div><h1>Raid Planner</h1></div>
        <div className="top-actions">
          <input className="raid-name" value={raidName} onChange={e => setRaidName(e.target.value)} />
          <button className="primary" onClick={save}><Save size={17}/> Save</button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="section-title"><span>PLAYERS</span><button className="icon-btn" onClick={addPlayer}><Plus size={18}/></button></div>
          <div className="player-list">
            {players.map(player => (
              <div key={player.id} className={`player ${selectedPlayer === player.id ? "selected" : ""}`} onClick={() => setSelectedPlayer(player.id)}>
                <span className="school-icon">{emoji[player.school]}</span>
                <span className="player-name">{player.name}</span>
                <button className="remove-player" onClick={e => { e.stopPropagation(); removePlayer(player.id); }}><Trash2 size={14}/></button>
              </div>
            ))}
          </div>

          <div className="section-title rounds-title"><span>ROUNDS</span><button className="icon-btn" onClick={addRound}><Plus size={18}/></button></div>
          <div className="round-list">
            {rounds.map(round => (
              <button key={round.id} className={`round-tab ${activeRound === round.id ? "active" : ""}`} onClick={() => setActiveRound(round.id)}>
                {round.name}<span>{round.assignments.length}</span>
              </button>
            ))}
          </div>
        </aside>

        <main className="main">
          <div className="round-header">
            <div><div className="eyebrow">CURRENT ROUND</div><h2>{currentRound.name}</h2></div>
            <button className="secondary" onClick={() => setPickerOpen(true)}><Plus size={17}/> Add Card</button>
          </div>

          <div className="player-grid">
            {players.map(player => (
              <section className="player-column" key={player.id}>
                <div className="column-header">
                  <span className="school-icon">{emoji[player.school]}</span>
                  <div><strong>{player.name}</strong><small>{player.school}</small></div>
                </div>
                <div className="assigned-cards">
                  {assignmentsFor(player.id).length === 0 ? (
                    <button className="empty-slot" onClick={() => { setSelectedPlayer(player.id); setPickerOpen(true); }}>
                      <Plus size={20}/><span>Add Card</span>
                    </button>
                  ) : (
                    <>
                      {assignmentsFor(player.id).map(({ cardId, index }) => {
                        const card = sampleCards.find(c => c.id === cardId)!;
                        return (
                          <div className="card-slot" key={`${cardId}-${index}`}>
                            <div className={`card-art ${card.school.toLowerCase()}`}>
                              <span>{emoji[card.school]}</span><strong>{card.name}</strong><small>{card.pips ? `${card.pips} pips` : card.type}</small>
                            </div>
                            <button className="card-remove" onClick={() => removeAssignment(index)}><X size={14}/></button>
                          </div>
                        );
                      })}
                      <button className="mini-add" onClick={() => { setSelectedPlayer(player.id); setPickerOpen(true); }}><Plus size={16}/> Add Card</button>
                    </>
                  )}
                </div>
              </section>
            ))}
          </div>
        </main>
      </div>

      {pickerOpen && (
        <div className="modal-backdrop" onMouseDown={() => setPickerOpen(false)}>
          <div className="picker" onMouseDown={e => e.stopPropagation()}>
            <div className="picker-header">
              <div><div className="eyebrow">CARD LIBRARY</div><h2>Select a Card</h2></div>
              <button className="icon-btn" onClick={() => setPickerOpen(false)}><X/></button>
            </div>
            <div className="filters">
              <div className="search-box"><Search size={17}/><input placeholder="Search cards..." value={query} onChange={e => setQuery(e.target.value)}/></div>
              <label>School<select value={school} onChange={e => setSchool(e.target.value as typeof school)}>{schools.map(s => <option key={s}>{s}</option>)}</select></label>
              <label>Type<select value={type} onChange={e => setType(e.target.value as typeof type)}>{cardTypes.map(t => <option key={t}>{t}</option>)}</select></label>
            </div>
            <div className="card-library">
              {filteredCards.map(card => (
                <button className="library-card" key={card.id} onClick={() => addCard(card)}>
                  <div className={`card-art large ${card.school.toLowerCase()}`}><span>{emoji[card.school]}</span><strong>{card.name}</strong><small>{card.pips ? `${card.pips} pips` : card.type}</small></div>
                  <div className="library-info"><strong>{card.name}</strong><span>{card.school} · {card.type}</span></div>
                </button>
              ))}
              {!filteredCards.length && <div className="no-results">No cards match your filters.</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}