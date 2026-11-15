-- Initial schema for an independent empty installation. No student data.
CREATE TABLE attempts (viewer INTEGER NOT NULL REFERENCES members(id), version INTEGER NOT NULL REFERENCES versions(id), started INTEGER, interrupted INTEGER, finished INTEGER, offer TEXT, audience TEXT, click TEXT, peer_questions TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(viewer,version));

CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL, team TEXT NOT NULL, recovery TEXT NOT NULL UNIQUE, dossier_id TEXT, current_attempt INTEGER NOT NULL DEFAULT 1, UNIQUE(team,name_key));

CREATE TABLE "round_runs" (
 token TEXT PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES rounds(id), viewer INTEGER NOT NULL REFERENCES members(id),
 practice INTEGER NOT NULL, phase INTEGER NOT NULL DEFAULT 0, started INTEGER, interrupted INTEGER, finished INTEGER, replies TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE "rounds" (
 id INTEGER PRIMARY KEY, author INTEGER NOT NULL REFERENCES members(id), step INTEGER NOT NULL CHECK(step BETWEEN 1 AND 12),
 input INTEGER NOT NULL REFERENCES versions(id), created INTEGER NOT NULL,
 prep TEXT NOT NULL, context TEXT NOT NULL, lens INTEGER, link TEXT NOT NULL,
 sketches TEXT NOT NULL, output INTEGER REFERENCES versions(id), decision TEXT, observation TEXT, choice TEXT, closed INTEGER, open_question TEXT,
 route_attempt INTEGER NOT NULL DEFAULT 1,
 UNIQUE(author,route_attempt,step)
);

CREATE TABLE route_restarts (
 author INTEGER NOT NULL REFERENCES members(id), previous_attempt INTEGER NOT NULL,
 request_key TEXT NOT NULL, created INTEGER NOT NULL, file_key TEXT NOT NULL UNIQUE,
 PRIMARY KEY(author,previous_attempt), UNIQUE(author,request_key)
);

CREATE TABLE self_tests (
  run TEXT PRIMARY KEY NOT NULL,
  viewer INTEGER NOT NULL REFERENCES members(id),
  version INTEGER NOT NULL REFERENCES versions(id),
  started INTEGER, interrupted INTEGER, finished INTEGER,
  offer TEXT, audience TEXT, click TEXT
);

CREATE TABLE sessions (token TEXT PRIMARY KEY, member INTEGER NOT NULL REFERENCES members(id), expires INTEGER NOT NULL);

CREATE TABLE versions (id INTEGER PRIMARY KEY, author INTEGER NOT NULL REFERENCES members(id), seq INTEGER NOT NULL, changed TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL, file_key TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, route_attempt INTEGER NOT NULL DEFAULT 1, UNIQUE(author,seq));

CREATE INDEX answers_by_version ON attempts(version,finished);

CREATE UNIQUE INDEX members_by_dossier ON members(dossier_id);

CREATE UNIQUE INDEX round_peer_once ON round_runs(round_id,viewer) WHERE practice=0;

CREATE INDEX round_results ON round_runs(round_id,finished);

CREATE INDEX self_tests_by_viewer ON self_tests(viewer,finished);
