# Race Report 1.0.7: notes for testers

Thanks for trying this. Race Report is a mod for Sauce for Zwift that records a race while you ride
it and then writes a report on how the race was raced.

## What it does

- Records your race by itself, from the gun to the finish line, then keeps watching for two minutes
  to see the riders behind you come in.
- Shows a report: the start, when your group split and who went, where you sat, time in the draft
  and in the wind, your biggest efforts, powerups and your finish.
- Two buttons copy a ready-made prompt plus the facts of your race, for you to paste into whatever
  AI you use: a race commentary about your team's race (or the whole field's) to share with team
  mates, or a coach's debrief to review your own race. Both open with an overview of the race.
- Everything stays on your computer. The mod makes no network requests of its own. The one button
  that reaches Zwift is "Get official results", and only when you press it.

## What you need

- Sauce for Zwift 2.3.0 or newer, on a Mac or on Windows.

## Installing it

1. Quit Sauce for Zwift.
2. Unzip the file. You get a folder called `race-report`.
3. Move that folder into your `SauceMods` folder, so you end up with
   `SauceMods/race-report/manifest.json`. Check it is not one folder too deep, such as
   `SauceMods/race-report/race-report/manifest.json`.
   - On a Mac, `SauceMods` is in your Documents folder.
   - On Windows it may be under OneDrive. The sure way to find it: open Sauce, go to Settings, then
     Mods, and press the button that opens the mods folder. Then quit Sauce again before step 4.
4. Start Sauce. It says "New Sauce MOD was found". Choose **Enable Now**. Sauce restarts itself.
5. In Sauce, open Settings, then Windows, and add **Race Report**. It is listed under
   `[MOD]: Race Report`.

## Using it

1. Open the Race Report window before your race starts. You can minimise it.
2. Ride. Recording starts by itself at the gun. If it does not, press **Start now**.
3. After the finish the report appears on the **Report** tab. The tabs are the three words under
   the header: Report, Recorded races, How this works.
4. Once the event is over for everyone, press **Get official results**. On Sauce 2.3.x this can
   say to try again later while other riders are still racing. That is a fault in Sauce, and
   nothing is lost.
5. Press either copy button and paste into your AI. Fetch the official results first: the
   overview and your team's places need them.
6. The race commentary finds your team mates by the team tag in your Zwift name, such as
   [MNSTRS]. To use a different tag, set it under **How this works**, "Your team tag".
7. Earlier races are on **Recorded races**. Press Open to see one.
8. Get official results also adds who was first across and fastest on each sprint and KOM. In a
   points race, keep Zenmaster's points leaderboard open too if you use it: Race Report then uses
   Zenmaster's results, which follow the race's scoring setup.

## What to send back

1. **The race file.** On the Report tab press **Save this race to a file**. It usually lands in
   your Downloads folder. It holds the names of the riders around you, as Sauce shows them, so only
   send it to me.
2. **What your AI wrote**, from either button, if you tried them.
3. **Anything wrong or confusing**, with a screenshot of the window if you can.
4. **Your Sauce version and whether you are on a Mac or Windows.** The Sauce version is under
   "Race Report" at the top left of the window.

## Updating or removing it

- **To update:** quit Sauce and replace the `race-report` folder with the new one. Your saved races
  are kept.
- **To remove:** quit Sauce and delete the `race-report` folder. Races saved inside Sauce go with
  it, so save any you want to keep to a file first.

## Please note

- This is a test version and it may have faults.
- Mods are written by third parties, not by Sauce or Zwift. Use it at your own risk.
- Your coach's debrief summarises your earlier races recorded by the mod, so it improves after a
  few races.
