# Race Report, a mod for Sauce for Zwift

Records one race as you ride it and then shows you a report about how that race was raced.
Everything stays on your own computer.

Needs Sauce for Zwift **2.3.0 or newer**. On an older build the data feed this mod uses may not
exist; the window says so rather than sitting there for ever.

## Installing it by hand

1. Quit Sauce for Zwift.
2. Copy this whole folder into your `SauceMods` folder, so that you end up with
   `SauceMods/race-report/manifest.json`.
   - The `SauceMods` folder lives inside your Documents folder. On Windows that may be under
     OneDrive rather than `C:\Users\<you>\Documents`, so the reliable way to find it is to open
     Sauce, go to **Settings > Mods** and press the button that opens the mods folder.
3. Start Sauce. It asks "New Sauce MOD was found". Choose **Enable Now**. Sauce restarts itself
   after a short notice.
4. Open Sauce's settings, go to **Windows**, and add **Race Report** from the list. It appears
   under the heading `[MOD]: Race Report`.
5. Leave the window open and ride a race.

The folder name you use becomes the mod's id, so keep it simple: `race-report`.

## Using it

- Leave the window open. It starts recording by itself at the gun and stops at the finish line.
  The gun is your category's scheduled start, as Sauce knows it, so the recording counts from
  there even if Zwift's own race clock for you starts later, and the report tells you when that
  happened. If you join after the gun, even straight from Zwift's home screen, it starts when you
  join and says how long after the gun that was. If you open the window, or restart Sauce, in the
  middle of a race, it picks the scheduled start up a moment later and still counts from the gun.
  If Sauce does not know the scheduled start at all, it counts from Zwift's race clock instead and
  says so. Sauce sometimes cannot look an event up at all; then nothing records by itself, and
  **Start now** is the way to catch that race.
  **Start now** and **Stop** are there for anything it does not catch by itself; a recording you
  start by hand keeps running until you press Stop.
- After your own finish it keeps watching for two more minutes, to see the riders behind you come
  in. The report describes that in its own part, **After the line**: who reached the line behind
  you and how far back, and any group that closed a gap. Every number about your own race still
  stops at the line, and exact finish times and places come from **Get official results**, not
  from that part. Pressing **Stop**, or leaving the event, ends the extra time at once. Change the
  time, or turn it off, under **How this works**.
- Your race is saved the moment you cross the line, and the report for it appears then. If you
  close Sauce during the extra time, the race is already kept whole; only the rest of the watching
  is lost. In an event that ends on the clock rather than at a distance, the clock runs out for
  everyone at once, so After the line lists who was behind you on the road when it did instead.
- When the race ends the report appears.
- Two copy buttons each put a ready made prompt plus the facts of the race on your clipboard, for
  two different reports. Paste either into whatever AI you already use. Nothing is sent anywhere by
  the mod.
  - **Copy race commentary for AI (to share)** asks for the race told as a story, from the start to
    the line, for team mates: what the groups did on the road, your climbs and your finish, and
    never why anyone did anything.
  - **Copy coach's debrief for AI** asks for a coach talking you through your own race, for your
    coach: where the race was decided for you, what each hard effort cost, and racing choices to
    try next time that survive a check against the facts. Never training advice. It also
    summarises up to three of your earlier races kept here.
  - Both texts are built by fixed rules: the start, splits of your group, the biggest moves of
    riders between groups, your hard efforts and the finish as key moments, plus your climbs, how
    the gaps moved (cut where a gap turned, so no rate runs across a gap that grew and then came
    down), and your finish (where you crossed within your group, counting riders of it who were
    ahead of you at the line and riders who came in after you, and when the group behind reached
    the line). A change of group is described by where riders were before and after, never by who
    moved.
  - A normal race comes to about 20 kB for the commentary and 21 to 25 kB for the debrief, a little
    more with long rider names. No text is ever longer than 50,000 characters: when one would be,
    it is built again with fewer names, coarser rows and shorter lists, step by step, until it
    fits, and it says what it left out.
  - Rider names and team tags are included; untick the box next to the buttons to replace every
    name with a label good for that race only and leave the team tags out. The box applies to both.
- **Recorded races** lists everything it has kept. Each one can be saved to a file or deleted.

## What it records, and what it does not

- Your own numbers second by second: power, heart rate, cadence, speed, draft, distance, grade,
  W'bal, the live race position Zwift reports, and Zwift's own race clock. It also keeps the
  scheduled start it counted from and how far this computer's clock was from Sauce's.
- The shape of the race around you: how big your group was, how many riders were in groups up the
  road, the gap to the group ahead and behind, the average power Sauce shows for your group, which
  riders were with you and when, and who was in the group just ahead of and just behind yours.
  That last part is a log of changes: a rider's move to another group is written down only once
  they have been out of their old group on every update for five seconds (twenty between the group
  next to yours and one further away on the same side), because Sauce's groups can flicker from one
  second to the next in a big field, and nothing is added to it after the line, except a change
  that held for the last three seconds before it. Group sizes in both copied texts and in the
  report's splits are counted from that log, not from any single update. A split of your group
  only counts once the smaller group has held for ten seconds.
- At the line, which riders of your own group were ahead of you, with Sauce's gap to each then, so
  the texts can say where in your group you crossed.
- Where on its road you were each second and which road, so the report can name a climb where
  Sauce itself has a route segment for that road. The segment names are read from Sauce's own
  files when the race is saved.
- For other riders it keeps the rider id, the name Sauce already shows in its own Nearby and
  Events windows, and the team tag Sauce reads out of that name and shows in its Groups window.
  While a rider is in your group it also keeps their power and draft, averaged every 10 seconds, as
  Sauce shows them in its Nearby and Groups windows, so the texts can say who had the most draft or
  spent longest in the wind. That is the one thing it keeps that Sauce shows but does not save, and
  it is only kept when your races are stored in IndexedDB. No avatar, no country, no weight, no FTP. Each rider also has a number good for
  that race only, which the group log uses instead of an id. Names are looked up from the profiles
  Sauce already holds on this computer, not fetched from Zwift.
- A rider Sauce cannot name appears as "Rider A", "Rider B" and so on, saved with no rider id at
  all. Those labels are good for one race and mean nothing in any other report.
- Sauce keeps an opt-out list of riders and drops them from the data before a mod sees them. On
  some Sauce versions that drop removes the wrong riders from a packet, so an opted-out rider can
  still reach a mod, always without a name, which is why the unnamed labels above matter.
- It counts the seconds it actually captured against the seconds the race ran, each recorded row
  at the interval it was recorded at. A recording with holes in it, or one that started after the gun (or well after you joined), is marked incomplete
  and says why.
- If you also run Arend teRaa's Zenmaster mod with its points leaderboard open, Race Report reads the
  sprint and KOM results Zenmaster saved for the race, after it, and gives the order across each
  scoring segment in both copied texts (names as Sauce shows them, no points). It only reads, and
  never creates or changes anything of Zenmaster's.
- It makes no network requests. The one button that reaches Zwift is **Get official results**,
  which makes the same call Sauce's own Events window makes when you open a finished event, on
  your own Zwift login. When Zenmaster saved no sprint and KOM results for the race, it also asks
  Zwift for the segment times on the sprints and KOMs you rode, as Sauce's own Analysis window
  does, and keeps only the order of the riders in the race. Nothing calls either unless you press it.

Recordings are kept on your computer in an IndexedDB database that belongs to this mod's window,
in your Sauce profile, which other enabled mods can read. They are deliberately not kept in the
local storage Sauce's own windows share. Every write there reaches every other Sauce window, and
for a name starting with "/" Sauce's Watching window reloads itself and the Overview bar rebuilds.
This mod used to write the whole race in progress there every 20 seconds, so those overlays
reloaded three times a minute through every race. Nothing the mod writes now has a name starting
with "/", its settings included. The first time the window opens outside an event after the
upgrade has been confirmed, the old copies are removed in one go and the overlays reload once.

Saving a long race does not thin it out: a three hour race keeps your own numbers every second and
the group around you every two seconds. How much the mod lets itself keep follows what your
computer says it has room for, and never more than about 500 MB. The mod asks Chromium to keep this
storage when the disk runs low; the window's console says whether it agreed. While a race runs,
only the seconds and riders that changed since the last save are written, every 20 seconds, so a
restart of Sauce loses at most that much. If a finished race cannot be saved, it is offered as a
file and its last snapshot is kept, to be offered again the next time the window opens.

If IndexedDB will not open in Sauce's window (it is tried twice), the mod falls back to Sauce's
shared local storage, under names Sauce's own windows ignore, in small pieces and once a minute,
and says on screen that races saved before may be missing from the list that time. There one race
is capped at about 400 kB and the total at about 1 MB, because that pool is shared with Sauce's own
settings, so a long race thins out as before. The next time IndexedDB opens, those races are moved
into it. Each saved race says which of the two kept it, in its `storedIn` field, and the window's
console says so once when it opens.

Races saved by an earlier version are copied over the first time the window opens. The old copies
are only removed on a later start that finds the new ones still there, so a store that did not
survive Sauce closing never costs a race. Races stay with the Sauce profile they were recorded in:
Sauce's Clone and Export profile do not copy them. Save anything you want to keep to a file.

Mods are written by third parties. Use at your own risk.

## Running the tests

    node test/run-tests.mjs

They need nothing but Node. Point `SAUCE_SRC` at a Sauce v2.3.0 checkout to also run the
manifest through Sauce's own validator.

## Licence

GPL-3.0, chosen to match the licence text Sauce for Zwift ships in its own `LICENSE` file. That
is a choice, not an obligation: Sauce's repository contradicts itself, with the full GPL-3.0 text
in `LICENSE` and `"license": "UNLICENSED"` in `package.json`, and whether a mod is a derivative
work is not settled by either. GPL-3.0 costs nothing here and matches what Sauce distributes. See
`LICENSE`.

## Home page and store listing

The mod's home is https://github.com/vkchap/sauce-race-report, and its logo is `logo.png` in
this folder. See `spec/build-plan.md` in the working folder for the submission checklist.
