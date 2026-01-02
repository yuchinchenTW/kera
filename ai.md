AI Heuristic Table

(Human Strategy → AI Belief & Utility Signals)

Purpose:
Convert human play heuristics into soft evidence signals for AI belief updates.

Rules:

Heuristics never hard-confirm roles.

Each signal applies a small belief delta.

Signals may conflict; belief model must normalize.

All heuristics are context-dependent.

1. General Heuristic Rules (Global)
ID	Heuristic	AI Interpretation	Belief Impact
G-1	Early, confident commitment (vote/speech)	Player likely has role-based information	+InfoScore
G-2	Repeated vote coordination with same players	Possible faction alignment	+FactionCorrelation
G-3	Avoids voting when night advantage exists	Player understands resource timing	+SkillEstimate
G-4	Willingly risks death to influence outcome	May be protecting higher-value role	+AltruismScore
G-5	Creates intentional ambiguity (tie votes)	Strategic delay for night action	+StrategicIntent

⚠️ Never infer alignment from speed alone.
Only patterns across multiple rounds count.

2. Civilian-Based Heuristics
ID	Source Behavior (Human Guide)	AI Signal	Belief Update
C-1	Follows police push decisively	Acting on trust of info source	Slight ↑ Blue
C-2	Refuses obvious bandwagon	Independent reasoning	↓ Randomness
C-3	Avoids pushing after police death	Defers to night info	↑ Experience
C-4	Dies early while leading vote	Possible shield behavior	↑ Blue
C-5	Pushes against revived / doctor-saved targets	Ignores medical signal	↑ Red (weak)

Implementation note:
Civilian heuristics mostly affect confidence in competence, not faction.

3. Sniper (G) Related Heuristics
ID	Source Behavior	AI Interpretation	Belief Update
G-S-1	Post-death lists (G-list) exist	Informational artifact	Boost targets’ scrutiny
G-S-2	G-list created when killers are few	Possible deception	Reduce trust in list
G-S-3	Player avoids killing high-impact targets	Resource conservation	↑ StrategicSkill
G-S-4	Player causes chaos to enable night kills	Sacrificial strategy	↑ Red if paired with night deaths
G-S-5	Keeps last bullet for endgame	Endgame planning	↑ Skill

Note:
G-related heuristics affect utility estimation, not direct role inference.

4. Police Heuristics
ID	Source Behavior	AI Interpretation	Belief Update
P-1	Avoids early voting	Protecting investigation	↑ Police
P-2	Death-triggered push list	Information release	↑ Trust in list
P-3	Delays reveal until pressure	Survival optimization	↑ Police
P-4	Coordinates push with teammate	Faction sync	↑ Blue cluster
P-5	Fake claims under disadvantage	Desperation play	Contextual

Special Rule:
Police heuristics weigh heavier after confirmation events (death, revive, investigation).

5. Killer Heuristics
ID	Source Behavior	AI Interpretation	Belief Update
K-1	Avoids early bandwagon	Concealment	↑ Red
K-2	Pushes low-information targets	Noise generation	↑ Red
K-3	Preserves disruptive players	Uses chaos	↑ Red
K-4	Manipulates tie votes	Night advantage exploitation	↑ Red
K-5	Provides misleading but plausible info	Deception skill	↑ Red + Skill

Killer heuristics affect both:

Faction probability

Threat priority (who to eliminate)

6. Doctor (E) Heuristics
ID	Source Behavior	AI Interpretation	Belief Update
E-1	Self-protect early	High self-value role	↑ Doctor
E-2	Double-protects push targets	Anticipates threat	↑ Blue
E-3	Conserves injections	Endgame planning	↑ Skill
E-4	Saves after public plea	Reactive defense	Neutral
E-5	Avoids saving obvious bait	Threat awareness	↑ Skill
7. Voting Pattern Heuristics
ID	Pattern	Interpretation	Belief Update
V-1	First voter on risky target	Info holder or bait	↑ RoleLikelihood
V-2	Last voter to secure execution	Opportunistic	↑ Red
V-3	Vote flip near deadline	Tactical adjustment	↑ Skill
V-4	Refuses to vote in winning position	Night preference	↑ Red or Blue (context)
V-5	Votes against clear majority	Counter-play	↑ Confidence
8. Anti-Heuristics (Bias Filters)

These prevent AI from learning bad human habits.

ID	Human Bias	AI Rule
A-1	“Fast vote = guilty”	Ignore speed-only signals
A-2	“High score = killer”	Ignore external reputation
A-3	“Loud player = bad”	Evaluate content, not volume
A-4	“Dead civilian prophecy”	Discount posthumous certainty
A-5	“Single tell = truth”	Require multi-signal confirmation
9. Heuristic Weighting Guidelines
Weak signal   : ±0.05 ~ 0.10
Medium signal : ±0.15 ~ 0.25
Strong signal : ±0.30 (rare, confirmation-based)
Never exceed cumulative ±0.6 without hard evidence.

10. Integration with AI System
Belief Update

Heuristics → likelihood multipliers

Normalize after every phase

Planner Usage

Beliefs influence:

Target selection

Risk tolerance

Tie-vote decisions

Difficulty Scaling

Easy: use 30–40% of heuristics

Normal: use all, weak weights

Hard: stronger normalization

Nightmare: combine with rollouts

11. Design Philosophy (Important)

Humans rely on intuition and fear.
AI relies on patterns and expected value.

This table ensures:

AI feels human-like

But does not inherit human superstition