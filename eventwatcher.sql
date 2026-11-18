-- Event Watcher table. This is created automatically when the app starts,
-- this file is only here for reference.

-- One row per event, e.g. releaseCreate, invoicePaid.
-- customProducts is a JSON list of overrides: [{"productID": 34, "embedColor": "#043753", "roleID": "", "channelID": ""}]
CREATE TABLE app_eventwatcher_events(
id INT NOT NULL AUTO_INCREMENT,
name VARCHAR(64) NOT NULL,
enabled BOOLEAN DEFAULT false,
discordChannel TEXT,
embedColor TEXT,
roleID TEXT,
pushover BOOLEAN DEFAULT false,
customProducts TEXT,
createdAt TEXT NOT NULL,
PRIMARY KEY (id),
UNIQUE (name));
