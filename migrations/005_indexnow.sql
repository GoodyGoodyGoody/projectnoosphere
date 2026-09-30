-- 005_indexnow: the key that proves to search engines (IndexNow: Bing, Yandex,
-- Seznam, Naver, Yep) that notifications about this host come from its owner.
--
-- Generated here, per install, so it is never in git. The server serves it at
-- /<key>.txt (the protocol's root key file); the librarian reads it through the
-- steward-only /api/v1/admin/indexnow and pings after publishing. The server
-- itself still makes no outbound requests. 32 hex characters: the protocol
-- allows 8-128 of [a-zA-Z0-9-].
INSERT OR IGNORE INTO settings (key, value) VALUES ('indexnow_key', lower(hex(randomblob(16))));
