-- Folders whose project was deleted with "keep the files on disk".
--
-- A rescan adopts every folder it has no project for, and since the library is watched a rescan
-- follows any change within seconds (and runs once a minute regardless). Without this table a
-- project deleted with its files kept was back before the user had looked away: "keep the files"
-- behaved like "forget the name, notes and tags". A folder listed here is left alone by adoption.
--
-- An entry lasts while its folder does. A rescan drops the entries whose folder is gone, so a
-- folder of that name made later (by hand, by an import) is adopted as usual, and renaming the
-- folder in Explorer makes it a new folder, which is adopted. Creating or renaming a project and
-- importing an archive never land on a released folder: all three refuse a folder name that
-- already exists on disk.
--
-- An older build ignores the table (it runs no migration past its own version) and re-adopts the
-- folders as before, which is that build's behaviour and nothing worse.
CREATE TABLE released_folders (
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dir_name    TEXT NOT NULL,
  released_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, dir_name)
);
