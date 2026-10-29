# Sharing game saves between the TV, RetroArch and the phone

The office TV's Library (office plan O5.3e) keeps each game's in-game save (the
battery save, `.srm`) in **RetroArch's own saves folder** on this PC. RetroArch on Steam
reads the same file, and Syncthing carries it to and from RetroArch on the phone. Save
states are a different thing: the TV keeps its own in Workbench's app data, and they
aren't shared.

## Where the TV puts saves

The Library's last row says where saves go. Choose it to set another folder by hand.

- **RetroArch on Steam** is found by itself through Steam's libraries
  (`steamapps\common\RetroArch\retroarch.cfg`); a standalone install in
  `%APPDATA%\RetroArch` is the fallback.
- The TV follows that config's **Saves** directory (`savefile_directory`, `:\saves` for
  Steam's RetroArch), and its sorting: by core name (`sort_savefiles_enable`) and by the
  content's folder (`sort_savefiles_by_content_enable`).
- A save is named after the game, as RetroArch names it:
  `saves\Genesis Plus GX\Sunset Riders (USA).srm`. A zipped game takes the name of the
  image inside the zip.
- Here, Steam's RetroArch sorts by core, so the TV's saves go to
  `C:\Program Files (x86)\Steam\steamapps\common\RetroArch\saves\<core>\`. Older saves
  sitting loose in `saves\` (from before sorting was on) aren't picked up. Move them
  into the core's folder if you want them.

| System | Core (on every device) | Folder |
|---|---|---|
| Mega Drive | Genesis Plus GX | `Genesis Plus GX` |
| NES | FCEUmm | `FCEUmm` |
| SNES | Snes9x (current, not 2002/2005/2010) | `Snes9x` |
| Game Boy / Color | Gambatte | `Gambatte` |
| Game Boy Advance | mGBA | `mGBA` |

## Syncthing

1. **PC:** install Syncthing (e.g. from syncthing.net, or SyncTrayzor for a tray icon).
   Add the RetroArch saves folder above as a shared folder.
2. **Phone:** install **Syncthing-Fork** from F-Droid or Google Play. Pair it with the
   PC (scan the PC's device ID QR code), then accept the shared folder and point it at
   the phone RetroArch's saves folder. That's usually
   `/storage/emulated/0/RetroArch/saves`; check RetroArch → Settings → Directory →
   Save Files.
3. Give the folder ignore patterns, so the TV's half-written files never travel:

   ```
   *.part
   ```

4. Leave it on "Send & Receive" on both sides.

## RetroArch on the phone must match

- **Same cores** as the table above. Each core writes its own format, and its folder is
  named after it.
- **Settings → Saving → Sort Saves into Folders by Core Name: on**, and **Sort Saves
  into Folders by Content Directory: off**, as on the PC. If you change one, change
  both.
- **The same file names for the games.** The save is named after the game's image.
- **SaveRAM Autosave Interval** (Settings → Saving), e.g. 10 seconds. RetroArch then
  writes the save while you play, not only on closing the game, and Syncthing has it
  sooner.
- Close the game, or wait for the autosave, before picking it up on another device.

## When two copies meet

- **The TV writes a save only over the copy it read.** If the file changed in the folder
  while you played on the TV (Syncthing brought the phone's), the TV pauses the game
  and asks:
  - **A** (or Start/Enter) keeps the TV's;
  - **B** takes the folder's and starts the game again from it.
- Either way, the copy not taken is backed up in Workbench's app data
  (`office-save-backups\<game>.<time>.<disk|tv>.srm`), outside the synced folder. To
  bring one back, copy it over the game's `.srm` in the saves folder and drop the
  `.<time>.<disk|tv>` part of its name.
- **Leaving a game while it's asking** keeps the folder's copy and backs up the TV's.
- **A TV save state kept with an older save** than the folder now has isn't resumed: the
  game starts from the folder's save instead, so an old state can't write old progress
  over new.
- If two devices save at once, Syncthing itself keeps the loser as
  `<name>.sync-conflict-….srm` beside it.
- Steam's RetroArch also has Steam Cloud on its saves folder (`steam_autocloud.vdf`).
  That's harmless alongside Syncthing.
