-- Visit log. One row per page load reported by the beacon.
--
-- `ip` is read from the edge connection (CF-Connecting-IP), never from the
-- request body: anything the client sends about its own address is spoofable.
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,          -- ISO-8601 UTC, server clock
  ip         TEXT NOT NULL,
  country    TEXT,                   -- edge geo, two-letter; NULL when unknown
  device_id  TEXT,                   -- browser-local UUID, groups repeat visits
  path       TEXT,
  referrer   TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS visits_at_idx     ON visits (at);
CREATE INDEX IF NOT EXISTS visits_ip_idx     ON visits (ip);
CREATE INDEX IF NOT EXISTS visits_device_idx ON visits (device_id);
