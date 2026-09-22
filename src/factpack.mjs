/*
 * Race Report - the fact packs.
 *
 * WHAT THIS FILE DOES: turns a finished recording into plain labelled text with units, preceded by
 * a prompt, for the rider to paste into whatever AI they already use. No key, no network, no AI in
 * the mod. Pure logic, testable in node.
 *
 * TWO STYLES. Van, 16 Sep 2026, after reading a sample of each written from the same race: "both
 * styles are good - they would be useful for different purposes - commentary to share with team
 * mates, debrief to review with my coach". So there are two copy buttons, each with its own prompt
 * and its own facts, and the single prompt that was here before is gone:
 *
 *   commentary   a race commentary to share: the race told in race terms, from the start to the
 *                line, about what happened on the road and never why.
 *   debrief      a coach's debrief to review: the rider's own race, what each effort cost, where
 *                the race was decided for them, and racing choices (never training) that survive a
 *                check against the facts, with the rider's earlier races for comparison.
 *
 * Both prompts are the version 2 prompts Van approved (spec/report-styles/prompt-commentary.txt
 * and prompt-debrief.txt), with three lines added for what the mod now also gives: the rider's
 * group's average power as Sauce works it out, team tags, and the W'bal model's own CP and W'. The
 * facts come from racefacts.mjs, by the rules in spec/report-styles/input-design.md.
 *
 * SIZE. Each text is meant to fit in a chat box: the commentary is aimed at under 24 kB and the
 * debrief under 30 kB, prompt included, and neither may pass 50,000 characters (HARD_CAP_CHARACTERS:
 * 30,000 until 22 Sep 2026, when terrain, who moved, the groups on the road and the rider's race
 * stretch by stretch made a 65 minute debrief lose most of its detail to the shortening ladder;
 * chat boxes take far more than either)
 * whatever the race. What keeps them near the aims: one or two minute overview rows, one shared row
 * budget for every key moment, at most eight moments, and caps on every list that grows with the
 * field. What enforces the cap: THE SHORTENING LADDER below.
 *
 * NAMES. The window itself always shows the names Sauce shows. This text includes them too, by
 * default (Van, 16 Sep 2026), and says so in its last line. Unticking the box next to the copy
 * buttons replaces every rider, including the rider whose report it is, with a per-race label with
 * no id behind it, and leaves out the team tags as well, which could otherwise say who a label is.
 */

import {
    buildReport, ownSeries, companions, companionsFromLog, sliceStats, fmtClock, fmtDuration, makeUnits, prettyPowerUp,
    afterLineFacts, afterLineEndedText, zwiftClockLate, zwiftClockLateText, joinedLateSecond,
    startedLateBy, ZWIFT_CLOCK_LATE_SECONDS, bestWindow, saucePowerPeaks,
} from './report.mjs';
import {
    raceContext, findClimbs, findEfforts, findMoments, climbLines, gapStretchLines,
    gapMilestoneLines, finishLines, powerUpLines, effortBlocks, overviewRows, rowStep,
    momentRows, momentRowsHead, roadAt, samePlaces, costBrief, moveEvents, isNearMove, moveLine, earlierRaceLines, wkg, distNum, distUnit,
    toGoAt, overviewStep, withoutBriefChanges, BRIEF_CHANGE_SECONDS, raceBriefLines, teamLines,
    terrainLines, terrainText, inGroupLines, inGroupSection, tagKey, roadGroupsSection, stretchLines,
    frontGapAt,
} from './racefacts.mjs';
import {MOVE_HOLD_SECONDS, SAME_SIDE_HOLD_FACTOR, isRaceLike} from './recorder.mjs';
import {segmentPointsLines, segmentPointsTitle} from './zenmaster.mjs';
import {SPLIT_HOLD_SECONDS} from './report.mjs';

const isNum = x => typeof x === 'number' && isFinite(x);

export const STYLES = ['commentary', 'debrief'];

export const PROMPTS = {
    commentary: `You are writing a RACE COMMENTARY: a written account of a Zwift race, told the way a race commentator would tell it afterwards, to share with the team mates of the rider whose recording this is. It is about the race and the rider's team, not about one rider. Below the rules are the facts a recorder collected from Sauce for Zwift while that rider rode the race. In the facts, "you" and "your" mean that rider.

RULES. Follow every one of them.

1. Use only the facts below. Never invent a number, a rider, a place, a gap, a time or an event. If something a reader would want is not in the facts (for example who won), say once, plainly, that it is not known, and move on. Do not name a climb, a banner or a sprint unless the facts name it.

2. You may use race language for movements the facts show on the road: a group went clear, the gap grew or came down, the bunch split, riders were dropped from a group, a rider or group came across, a group was caught. Every such sentence must match a fact: a change in group size, a rider changing group, or a gap between groups. Where a change of group says who moved ("they were dropped", "they rode clear", "your group caught them", "they caught your group", "you were dropped"), follow it; where it says nothing, say only where riders ended up.

3. Never say or suggest why anyone did anything, or what anyone was thinking, planning, trying or feeling. Do not write "attacked", "tried", "wanted", "decided", "gambled", "chose", "sat in", "played it", "tactical", "saving themselves", "desperate", "cracked" or "suffered". Say what happened on the road, not why. One exception: where the facts say "your move", you may say the recording rider attacked or went clear. Never say it of anyone else.

4. Riders' own numbers come only from WHO DID WHAT IN YOUR GROUP and each moment's "In your group" line: you may say who had the most or least draft, the highest or lowest power, and who spent longest with no draft, and whether that was shared, for the recording rider as for anyone. Nothing else about anyone's effort: not who was strongest or tired, and no heart rate. No draft is not "on the front" or "pulling": say "in the wind" or "did the most work in the wind". A group's average power may be given as the group's.

5. Nobody's position inside a group is recorded. Do not say "on the front", "on the wheel", "sixth wheel", "at the back of the bunch" or anything like it, for anyone. The order in which riders crossed the finish line is different: YOUR FINISH and the official results give it where it is known, and you should use it.

6. Gaps are Sauce's live road gaps and can be a second or so out. Write them as "about 10 seconds", not "10.2 seconds". Write a gap over a minute in minutes and seconds: "about a minute and 45 seconds", not "106 seconds". Zwift's live position is not an official result; call it Zwift's live position.

7. Riders are named exactly as the facts name them. A rider shown as "Rider A", "Rider B" and so on could not be named: keep the label exactly and never guess who it is. Named riders are real people: write only what they did on the road. Give a rider's team tag only the first time you name them; after that use the name alone. Nothing in the facts says whether any rider is a man or a woman: use their name or "they", never "he", "she", "his" or "her".

8. The team. THE RIDER'S TEAM gives the recording rider's team tag and the riders who carry it. Tags are sometimes spelled differently (for example MNSTRS, MNSTR, Mnstrs or MNSTRS 2) or written into a name without brackets. Count a tag or name that is plainly another spelling of the rider's team tag as the same team, and say once that you did. Do not stretch this to tags that only look a little alike. A shared tag says who is on a team, not that they worked together: never say team mates helped, protected or rode for each other.

9. Sauce only sees the riders within a few minutes of the recording rider on the road. For anyone it did not see, the official results are all there is: give their place and time, not a story.

10. Where the facts say part of the race was not recorded, say so rather than describing it. The section WHAT IS NOT KNOWN is a hard limit: do not work around it.

11. No em dashes. No hype that the numbers do not support. Plain, specific sentences.

HOW TO WRITE IT

- Refer to the recording rider by name, never as "you". If the facts withhold the names, call them "the rider".
- The facts are written from the recording rider's seat ("your group"), but the story is not about them. Tell it from the front of the race: how the leading group formed and who was in it first, then the groups behind. Describe a group by who was in it or where it was on the road ("the group of five", "the chasers"), never as the recording rider's group. Name the recording rider at most twice in the whole commentary, unless team mates are in the race, when each of the team gets the same attention.
- Start with a title of a few words.
- The first paragraph is an overview of the whole race, from THE RACE IN BRIEF: the field, where it came apart, who won, and how the team finished (with no team mates in the race, how the field finished). Three or four sentences. Then tell the race in order, from the start to the line, in past tense.
- Use THE GROUPS ON THE ROAD for the groups further up and down the road: when one split or grew, and how fast each was going. A group going faster than the one ahead of it was closing on it.
- With team mates in the race, tell it as the team's race: which groups the team's riders were in, who made the splits and who missed them, and where each one finished. The recording rider is one of the team, no more. With no team mates in the race, tell the race of the whole field as Sauce saw it.
- Tell it in race terms. The facts use their own labels; never repeat them. Do not write "key moment", "moment", "hard effort", "biggest effort", "row", "record", "recorder", "window", "fact" or "data" in the story.
- Build the story around the KEY MOMENTS. Use MINUTE BY MINUTE, WHO WAS WHERE and HOW THE GAPS MOVED for what happened between them, in a sentence or two, not minute by minute.
- For each moment say when and where it happened (race time, and km to go or the climb from CLIMBS), what the groups looked like before and after, and who moved.
- When an effort or a climb is part of a moment, use the effort's or the climb's own times, not the times of the moment around it.
- When the facts give sprint and KOM results (from Zenmaster or Zwift's segment times), say who was first across and fastest on the ones that shaped the race, and how the team did on them. They are the order only: give no points.
- Say what the road was doing where it matters, from TERRAIN and each moment's road line: a split on a climb, a gap that grew on a descent, a flat run-in. Give each climb a sentence on what the groups did on it. Use HOW THE GAPS MOVED for the shape of a gap: "the four gained about 7 seconds a minute".
- End with the finish: the winner and the podium from the official results, the team's places if there are team mates, and how the groups behind crossed from YOUR FINISH. Do not list every place. If some riders crossed within about a second of each other, say once that the order between them is close enough to be uncertain. If the official results were not fetched, say that the winner and the full order are not known.
- For a group behind, give the time it reached the line after the recording rider and say that is what it is. For the group ahead, the road gap as the recording rider crossed is all there is, unless the official results give their times.
- Leave out notes about the facts themselves, such as a distance counter that does not match the listed distance, or live positions that differ during the race. If one of them changes how the result should be read, give it one short sentence before the finish, not after it.
- Use a number only where it tells the story: group sizes, gaps, places, times. Two or three such numbers a paragraph at most. Race times, km, km to go and rider names or labels do not count toward that limit.
- 250 to 400 words, and no more: this is a limit, not a guide. Tell only the moves that shaped the result. A split that lasted more than 30 seconds may be told, even if it came back together; leave out riders coming off a group and getting back on, and other small changes.
- Prose paragraphs. No tables, no bullet points, no headings apart from the title.`,

    debrief: `You are writing a COACH'S DEBRIEF: an experienced race coach talking a rider through their own Zwift race afterwards, from the recording. Below the rules are the facts a recorder collected from Sauce for Zwift while the race was ridden.

RULES. Follow every one of them.

1. Use only the facts below. Never invent a number, a rider, a place, a gap, a time or an event. If something you need is not in the facts, say it is not known. Do not fill gaps from general knowledge of Zwift racing, except what a powerup does, which POWERUPS ACTIVE ON YOU gives.

2. You may interpret the rider's OWN race: where their efforts were spent, what each one cost (power, kJ, W'bal, heart rate, how long the reserve took to come back), what the groups were doing while they spent it, where the race was won or lost for them, and what racing choices they could try next time in a similar race.

3. Keep facts and interpretation apart, and label the interpretation. In each section give the facts first, in the form HOW TO WRITE IT gives for that section. Then, where there is something to add, one short paragraph of at most three sentences that starts "My read:". It may mix facts and meaning, as a coach would ("You held 5.4 W/kg for the whole climb and the gap still grew, so..."), but must not restate the facts above it. Everything under "Next time in a race like this" is interpretation and needs no label. Use "My read:" only for something the numbers do not state directly.

4. Racing choices only. Do not give training advice: no workouts, intervals, training plans, fitness or FTP goals, recovery, nutrition, equipment or preparation. A racing choice is something the rider could do differently during a race: when to spend an effort, when to follow a move and when to let it go, how hard to start, when to use a powerup, where in the race to hold back.

5. Check every racing choice before you offer it. Look for any fact that undoes it: whether the reserve had already come back before the moment that mattered, what the groups were doing (a gap that was already growing, a group already out of reach, a place already won), and what the facts say is not known. Drop a choice that fails the check. Offer at most three; fewer is fine, and if none survives, say so in one sentence. Each choice names the moment and the fact it rests on, says what on the road it could change in this race, and is phrased as something to try, not an order. Never say a choice would have worked. Do not offer a choice that your section "What the data cannot tell us" says cannot be judged.

6. Where the facts say "your move", you may say you attacked or went clear. Never say or suggest why another rider did anything, or what they were thinking. Other riders' own numbers come only from WHO DID WHAT IN YOUR GROUP and each moment's "In your group" line: you may compare your draft, power and time with no draft with theirs as it gives them. Do not say who was strongest or tired, and call no draft "in the wind", never "on the front" or "pulling". You may say what the groups did on the road while the rider did something. Where a change of group says who moved, follow it; where it says nothing, do not guess. Your group's average power is Sauce's average over everyone in the group, the rider included; give it only as the group's average.

7. Nobody's position inside a group is recorded. Do not say the rider was "on the front", "on the wheel" or "at the back". "In a group with no draft" is not the same as "on the front". The order riders crossed the finish line is different: YOUR FINISH gives it where it is known.

8. W'bal is a model, not a measurement, and runs on the critical power and W' given under HOW TO READ THESE FACTS. Say "the model had you at" rather than stating it as a fact about the body. Give it as a share of the reserve ("the model had you at about a third of your reserve"); give joules at most once per effort, in brackets. Give power on a climb or a hard effort in W/kg as well as watts. Gaps are Sauce's live road gaps and can be a second or so out; write them as "about". Zwift's live position is not an official result.

9. Earlier races: compare only on the measures given, name how the races differ (route, length, a record that is incomplete), and do not call anything a trend from fewer than three comparable races.

10. Riders are named exactly as the facts name them; keep labels such as "Rider A" exactly and never guess who they are. A tag in square brackets after a name is the team tag Sauce read from that rider's Zwift name, not proof they rode as a team; give it only the first time you name a rider. Nothing in the facts says whether any other rider is a man or a woman: use their name or "they", never "he", "she", "his" or "her". Where the facts say part of the race was not recorded, say so. The section WHAT IS NOT KNOWN is a hard limit.

11. No em dashes. Plain, specific sentences. Do not repeat the facts' own labels ("key moment", "row", "the recorder"); talk about the race.

HOW TO WRITE IT

- Address the rider as "you", as a coach would face to face.
- About 500 words, and no more than 550: this is a limit, not a guide.
- Say each thing once: the main climb, a split, each effort, your place and the winner are given in full in one section only, and referred back to in a few words anywhere else.
- Bullets where numbers are compared, prose where a sequence is told, as each heading says. A bullet effort reads "13:41, 1m 10s at 412 W (4.8 W/kg): reserve 46% to 6%, half back after 7m 43s". In prose, at most two numbers a sentence.
- Use these headings, in this order:
  The race: two or three sentences from THE RACE IN BRIEF, seen from where you were in it: the field and who won, where it came apart and which side you were on, and where you finished. Leave the split's names and times for later. Mention team mates from THE RIDER'S TEAM only where it helps.
  Your race, start to finish: one short paragraph telling your own race in order from YOUR RACE STRETCH BY STRETCH: how far you were from the front and how that changed, who you caught, who you lost and who came back, where on the road each happened, who you rode with, and how your group finished. Names, gaps and the road, not watts; the watts belong below.
  The short version: three bullets, one plain sentence each with at most one number: what decided your race, what it cost you, and what you did at the finish. Not your place or the winner again.
  Where the race was decided for you: a short paragraph telling, in order, the one or two KEY MOMENTS that set your result: what the road was doing (TERRAIN), what you rode, what the groups did (HOW THE GAPS MOVED), and where that left you. Then "My read:".
  (If the facts give sprint and KOM results (from Zenmaster or Zwift's segment times), say in a sentence where you placed on them, inside Where the race was decided or What your efforts cost. The order only, no points.)
  What your efforts cost: one bullet per effort from YOUR BIGGEST EFFORTS, in time order, with what it took from the W'bal model and how long it took to come back. For an effort already given above, only what it cost.
  In the draft and in the wind: one or two sentences of prose on the follow, work and solo split, with the caveat in rule 7.
  Compared with your earlier races: only if the facts include a comparable one; one or two sentences.
  Next time in a race like this: the racing choices that survive rule 5, one bullet each, one or two sentences.
  What the data cannot tell us: one or two sentences, none of which undoes a choice you offered.
- Leave out notes about the facts themselves, such as a distance counter that does not match the listed distance, unless one changes what a number means.`,
};

/*
 * A team tag is kept only when it looks like a team code. Sauce reads a tag from whatever a rider put
 * in brackets in their Zwift name (src/stats.mjs:70-89), which on 17 Sep 2026 gave one rider the tag
 * "@bluesky | RtB | ..." with symbols in it, and the race commentary printed it whole.
 */
export function shortTag(tag) {
    return typeof tag === 'string' && /^[\p{L}\p{N}][\p{L}\p{N} ._&'-]{0,15}$/u.test(tag.trim()) ? tag.trim() : null;
}

/*
 * Each rider's tag is given the first time the text names them and not again: the race commentary of
 * 17 Sep 2026 repeated "[HBRD]" and "[BCC]" at every mention. `tagged` is [name, tag] pairs.
 */
export function tagOnce(text, tagged) {
    for (const [name, tag] of tagged) {
        const full = `${name} [${tag}]`;
        const first = text.indexOf(full);
        if (first < 0) {
            continue;
        }
        const head = text.slice(0, first + full.length);
        text = head + text.slice(head.length).split(full).join(name);
    }
    return text;
}

// A split back together within this long is not a key moment in the race commentary (findMoments).
export const COMMENTARY_MIN_SPLIT_SECONDS = 30;

// Row budgets for the key moments, shared across a race (rowStep in racefacts.mjs).
const ROWS = {commentary: {finest: 10, budget: 20}, debrief: {finest: 5, budget: 24}};
export const MAX_EARLIER_RACES = 3;

// No text may be longer than this, whatever the race (spec/report-styles/input-design.md).
export const HARD_CAP_CHARACTERS = 50000;

/*
 * THE SHORTENING LADDER. The caps below keep a normal race well inside the size aims, but a text
 * grows with the field, the length of the race, the length of the riders' names, the official
 * results and the earlier races, and a review on 16 Sep 2026 found a three hour race of 100
 * riders with real length names at 32,900 characters. So buildFactPack builds the text, and while
 * it is over HARD_CAP_CHARACTERS builds it again one step further down this ladder, each step
 * keeping what the steps before it cut. The text says what was shortened.
 */
const FULL_LISTS = {
    namesBrief: false, moveNames: 6, movesPerMoment: 10, moveLines: 12, rowsDivisor: 1, overviewFactor: 1,
    earlier: MAX_EARLIER_RACES, gapLines: 6, milestones: 8, companions: 10, arrivals: 30, results: 40,
    momentRows: true, finishNames: 6, climbsBrief: false, momentGroups: true, climbs: Infinity,
    terrainRows: 30, roadEvents: 12,
};
const LADDER = [
    ['fewer rider names in each group and each change of group, and the road in fewer, longer stretches',
     {namesBrief: true, moveNames: 3, movesPerMoment: 5, moveLines: 6, finishNames: 3, terrainRows: 15}],
    ['the rows inside key moments twice as far apart', {rowsDivisor: 2}],
    ['the overview rows twice as far apart', {overviewFactor: 2}],
    ['shorter lists of earlier races, gap stretches, gap milestones, riders in your group, arrivals ' +
     'and official results', {earlier: 1, gapLines: 5, milestones: 4, companions: 5, arrivals: 10, results: 20,
                              roadEvents: 6}],
    ['the rows inside key moments four times as far apart, and fewer changes of group listed',
     {rowsDivisor: 4, moveNames: 2, movesPerMoment: 3, moveLines: 3}],
    ['no earlier races, and the overview rows four times as far apart',
     {earlier: 0, overviewFactor: 4, gapLines: 3, milestones: 2, results: 10}],
    ['one line for each climb, without the groups either side', {climbsBrief: true}],
    ['no rows inside key moments', {momentRows: false, movesPerMoment: 2, arrivals: 5, companions: 3}],
    // The last step leaves only what no race can make long, so every text ends under the cap.
    ['no group listings inside key moments, and only the first eight climbs',
     {momentGroups: false, movesPerMoment: 0, moveLines: 0, climbs: 8, gapLines: 2, milestones: 0, results: 5}],
];


/*
 * Whether a stored recording, or its entry in the list, is an earlier race to set beside `rec`: one
 * that started by itself in an event, not one started by hand; not a first half of this same race
 * saved after a restart (the same event subgroup); and a race by Zwift's type (isRaceLike), or at
 * least listed as the same type of event as this one, since a community race is often listed as a
 * group ride. A field the entry does not have, or has as not known, does not rule it out.
 */
export function isEarlierRace(x, rec) {
    const trigger = x.trigger;
    const sg = x.eventSubgroupId;
    const type = x.eventType !== undefined ? x.eventType : x.event && x.event.eventType;
    if (trigger !== undefined && trigger !== 'auto') {
        return false;
    }
    if (sg != null && rec.eventSubgroupId != null && sg === rec.eventSubgroupId) {
        return false;
    }
    if (type != null) {
        return isRaceLike({eventType: type}) || type === (rec.event ? rec.event.eventType : null);
    }
    return true;
}


/*
 * One label per rider, in order of first appearance, used when names are being withheld. Built
 * fresh for each fact pack, so the labels mean nothing in any other race or any other copy.
 */
function anonymousNames(riders) {
    const entries = Object.entries(riders || {})
        .sort((a, b) => (a[1].firstT ?? 0) - (b[1].firstT ?? 0));
    const map = new Map();
    entries.forEach(([key], i) => {
        let n = i;
        let s = '';
        do {
            s = String.fromCharCode(65 + (n % 26)) + s;
            n = Math.floor(n / 26) - 1;
        } while (n >= 0);
        map.set(key, `Rider ${s}`);
    });
    return map;
}


/*
 * options:
 *   style          'commentary' (the default) or 'debrief'
 *   includeNames   rider names and team tags in the text (default true)
 *   imperial       miles rather than kilometres
 *   model          buildReport's model for this recording, if already built
 *   earlier        for the debrief: earlier recordings, newest first, to summarise
 */
/* THE RACE IN BRIEF, with names, for the window's own first section. */
export function raceOverviewLines(rec, {imperial = false, model = null} = {}) {
    const all = {...(rec.riders || {}), ...((rec.afterLine && rec.afterLine.riders) || {})};
    const ctx = raceContext(rec, {
        model: model || buildReport(rec, {imperial}),
        units: makeUnits(imperial),
        nameOfKey: key => (all[key] && (all[key].name || all[key].label)) || 'no name',
    });
    return raceBriefLines(ctx, {climbs: findClimbs(ctx)});
}

export function buildFactPack(rec, options = {}) {
    const model = options.model || buildReport(rec, options);
    let lists = {...FULL_LISTS};
    const cut = [];
    let text = packText(rec, {...options, model}, lists, cut);
    for (const [what, step] of LADDER) {
        if (text.length <= HARD_CAP_CHARACTERS) {
            break;
        }
        lists = {...lists, ...step};
        cut.push(what);
        text = packText(rec, {...options, model}, lists, cut);
    }
    return text;
}

function packText(rec, options, lists, cut) {
    const style = options.style === 'debrief' ? 'debrief' : 'commentary';
    const debrief = style === 'debrief';
    const U = makeUnits(options.imperial);
    const model = options.model;
    // Names are in unless the rider unticks the box (Van, 16 Sep 2026).
    const includeNames = options.includeNames !== false;
    const own = ownSeries(rec);
    const tl = rec.timeline || {};
    const stats = rec.stats || null;
    const ev = rec.event || {};
    const raceSeconds = model.meta.raceSeconds;
    const firstSecond = model.meta.firstSecond || 0;
    const allRiders = {...(rec.riders || {}), ...((rec.afterLine && rec.afterLine.riders) || {})};
    // Riders first seen after the line are labelled too. They were first seen after every race
    // rider, so they take the next labels and the race's own labels do not move.
    const anon = includeNames ? null : anonymousNames(allRiders);
    // Riders are keyed by their athlete id when Sauce named them, and by their label when it did
    // not, so the key is the only handle both cases share.
    const nameOf = (key, fallback) =>
        (anon ? (anon.get(String(key)) || 'an unrecorded rider') :
            (fallback || (allRiders[key] && (allRiders[key].name || allRiders[key].label)) || 'no name'));
    const teamOf = key => (includeNames && allRiders[key] && shortTag(allRiders[key].team)) || null;
    const shown = (key, fallback) => `${nameOf(key, fallback)}${teamOf(key) ? ` [${teamOf(key)}]` : ''}`;
    const ctx = raceContext(rec, {model, units: U, nameOfKey: key => nameOf(key), teamOfKey: teamOf});
    const climbs = findClimbs(ctx);
    const efforts = findEfforts(ctx);
    /*
     * The race commentary is about the field or the team, not the recording rider (Van, 18 Sep
     * 2026: "it brought me up a lot which it shouldn't"), so its key moments come from the race
     * alone, never from the rider's own hard efforts, and it is given none of the rider's power.
     */
    const {moments, dropped} = findMoments(ctx, {efforts: debrief ? efforts : [], climbs,
        minSplitSeconds: debrief ? 0 : COMMENTARY_MIN_SPLIT_SECONDS});
    const u = distUnit(ctx);
    const L = [];
    const section = (title, ...lines) => {
        L.push('', `=== ${title} ===`, ...lines);
    };

    L.push(PROMPTS[style]);
    L.push('');
    if (!includeNames) {
        L.push('NOTE: rider names were deliberately left out of this text. Everyone, including ' +
               'the rider whose report this is, appears as a label that is good for this race ' +
               'only and carries no rider id. Team tags are left out too.');
        L.push('');
    }

    // ---------------------------------------------------------------- the race and the record
    L.push('=== RACE ===');
    L.push(`Event: ${ev.name || 'not known'}`);
    if (ev.subgroupLabel) {
        L.push(`Category or group: ${ev.subgroupLabel}`);
    }
    L.push(`Event type: ${ev.prettyType || ev.eventType || 'not known'}`);
    L.push(`Route: ${ev.routeName || 'not known'}`);
    if (isNum(ev.routeDistance) || isNum(ev.distanceInMeters)) {
        const d = isNum(ev.distanceInMeters) && ev.distanceInMeters ? ev.distanceInMeters : ev.routeDistance;
        L.push(`Event distance: ${U.dist(d)}`);
    }
    if (isNum(ev.routeClimbing)) {
        L.push(`Event climbing: ${U.elev(ev.routeClimbing)}`);
    }
    if (isNum(ev.laps) && ev.laps) {
        L.push(`Laps: ${ev.laps}`);
    }
    if (rec.gunSource === 'scheduled-start' && rec.scheduledStartISO) {
        L.push(`Scheduled start of the category (the gun): ${rec.scheduledStartISO}`);
    }
    L.push(`Started: ${rec.startedISO || 'not known'}`);
    L.push(`Recording ended because: ${rec.stopReason || 'not known'}`);
    if (ev.powerUps && (Array.isArray(ev.powerUps) ? ev.powerUps.length : Object.keys(ev.powerUps).length)) {
        const list = Array.isArray(ev.powerUps) ? ev.powerUps : Object.keys(ev.powerUps);
        L.push(`Powerups the organiser listed: ${list.map(prettyPowerUp).join(', ')}`);
    }

    const nameOfResult = r => includeNames ? (r.name || '(no name)') : '(name withheld)';
    section('THE RACE IN BRIEF',
        'Worked out by the recorder, for the overview that opens the text.',
        ...raceBriefLines(ctx, {climbs, nameOfResult, field: !debrief}));

    section('HOW COMPLETE THIS RECORD IS', ...completenessLines(rec, model, own),
        ...(cut.length ? [`To fit in a chat box this text was shortened: ${cut.join('; ')}. Nothing was ` +
            'reworded: parts were left out or given in coarser rows.'] : []));

    section('THE RIDER (whose report this is)');
    if (rec.self) {
        L.push(`Name: ${includeNames ? (rec.self.name || 'not known') : 'withheld, call them "the rider"'}`);
        if (isNum(rec.self.ftp)) {
            L.push(`FTP as Zwift has it: ${Math.round(rec.self.ftp)} W`);
        }
        if (isNum(rec.self.weight)) {
            L.push(`Weight as Zwift has it: ${rec.self.weight.toFixed(1)} kg`);
        }
    }
    const finalPos = isNum(rec.finishPosition) ? rec.finishPosition : lastNum(tl.eventPosition);
    const participants = isNum(rec.finishParticipants) ? rec.finishParticipants : lastNum(tl.eventParticipants);
    L.push(`Last live race position Zwift reported: ${isNum(finalPos) ? finalPos : 'not known'}` +
        `${isNum(participants) ? ` of ${participants}` : ''}. Not an official result.`);

    section("THE RIDER'S TEAM", ...teamLines(ctx, {
        teamTag: options.teamTag ?? (rec.self && rec.self.team), includeNames, shortTag, nameOfResult}));

    // ---------------------------------------------------------------- how to read them
    section('HOW TO READ THESE FACTS',
        `Times are minutes:seconds from the gun. "${u} to go" counts back from your own distance counter ` +
        `at the line${ctx.finished ? '' : ' (this record did not reach the line, so from the listed distance)'}.`,
        'A "group" is Sauce\'s own grouping on the road; "your group" includes you; "ahead" and "behind" ' +
        'are the nearest other group each side, as riders @ gap. Gaps are Sauce\'s live road gaps and can ' +
        'be a second or so out.',
        ctx.hasMoves ?
            `Sauce's grouping can flicker in a big field, so a change of group counts once it held ` +
            `${MOVE_HOLD_SECONDS} s (${MOVE_HOLD_SECONDS * SAME_SIDE_HOLD_FACTOR} s between two groups on the ` +
            `same side of yours), group sizes are counted from those changes, and a split of your group ` +
            `counts once its size held ${SPLIT_HOLD_SECONDS} s. "4 @ ?" is a group whose gap could not be ` +
            'matched to it on Sauce\'s rows at that time.' :
            `A split of your group counts once its size held ${SPLIT_HOLD_SECONDS} s, because Sauce's grouping ` +
            'can flicker in a big field. A row that flickered is left out.',
        'Not in these facts: where anyone sat in a group, and any other rider\'s own power, heart rate or ' +
        'effort. "Your group\'s average" is Sauce\'s average power over your whole group, you included.' +
        `${includeNames ? ' [TAG] is the team tag Sauce read from a rider\'s Zwift name, given the first time the rider is named.' : ''}`,
        'Position is Zwift\'s live position, not a result; for the line use YOUR FINISH.' +
        `${ctx.weight ? ' W/kg uses your weight in Zwift.' : ' Your weight is not known, so there is no W/kg.'}`,
        'Moment rows: power, heart rate, draft and speed average the seconds up to the time shown; the ' +
        'rest are the value then; a powerup name means it was active on you.');
    if (debrief) {
        L.push('f/w/s counts seconds in a group with draft / in a group with no draft / with no group; ' +
            'no draft is not the same as on the front.');
        L.push(`W'bal is Sauce's model of your reserve, not a measurement, run at a critical power of ` +
            `${isNum(ctx.cp) ? `${Math.round(ctx.cp)} W` : 'not known'}` +
            `${isNum(ctx.cp) && ctx.cpFromFtp ? ' (your FTP, as no critical power is set in Sauce)' : ''} and ` +
            ({
                profile: `a W' of ${Math.round(ctx.wPrime)} J from your profile`,
                'sauce-default': `a W' of ${Math.round(ctx.wPrime)} J, which is Sauce's default, stored when no W' ` +
                    'has been set, so it is not a measure of this rider. Where the model goes below 0%, the ' +
                    'rider rode more than these two settings allow; say that once, as a limit of the settings, ' +
                    'and read the shares as rough',
                highest: 'a W\' that was not saved with this recording. The shares below are of the highest ' +
                    `W'bal the record holds, ${Math.round(ctx.wPrime)} J; the model never goes above its W', so ` +
                    'the reserve it ran on was at least that',
                default: `Sauce's default W' of ${Math.round(ctx.wPrime)} J, as neither your W' nor any W'bal ` +
                    'was saved with this recording, so the shares below are rough',
            })[ctx.wPrimeSource] +
            '; given as a share of that reserve, 100% full, 0% empty.');
    }

    // ---------------------------------------------------------------- the whole race
    if (debrief) {
        section('THE WHOLE RACE, YOUR NUMBERS', ...wholeRaceLines(rec, own, stats, U, model));
    } else {
        // Nothing about the recording rider's own numbers: see the key moments above.
    }

    // One title whatever the step, because both prompts send the AI to MINUTE BY MINUTE.
    const oStep = overviewStep(ctx, lists.overviewFactor);
    section(oStep === 60 ? 'MINUTE BY MINUTE' : `MINUTE BY MINUTE (one row every ${oStep / 60} minutes)`,
        ...overviewRows(ctx, {debrief, factor: lists.overviewFactor}));

    // ---------------------------------------------------------------- key moments
    section('KEY MOMENTS',
        'By fixed rules: the start, splits of your group, the biggest moves between groups, your hard ' +
        'efforts (10 s or more at 110 percent of FTP) and the finish, merged where they overlap: ' +
        `${moments.length} here${dropped ? `, ${dropped} with fewer reasons left out` : ''}. A window opens before ` +
        'and closes after what happened; for an effort or a climb use its own times. Groups: riders @ gap.',
        `Columns of every moment's rows: ${momentRowsHead(ctx, {debrief})}`);
    // Each group is named once and then referred back to while its riders stay the same.
    const opts = {namesInOwnGroup: !debrief, memo: new Map(), brief: debrief || lists.namesBrief};
    const step = rowStep(moments, {finest: ROWS[style].finest, budget: ROWS[style].budget / lists.rowsDivisor});
    moments.forEach((m, k) => {
        const g0 = toGoAt(ctx, m.t0);
        const g1 = toGoAt(ctx, m.t1);
        L.push('', `--- MOMENT ${k + 1}: ${fmtClock(m.t0)} to ${fmtClock(m.t1)}` +
            `${isNum(g0) && isNum(g1) ? `, ${distNum(ctx, g0)} to ${distNum(ctx, g1)} ${u} to go` : ''} ---`,
            `Why: ${m.tags.join('; ')}.`);
        for (const c of m.climbs) {
            L.push(`The road: climb ${c.n} (see CLIMBS) ran ${fmtClock(c.t0)} to ${fmtClock(c.t1)}.`);
        }
        const road = terrainText(ctx, m.t0, m.t1);
        if (road) {
            L.push(`The road over the whole moment: ${road}.`);
        }
        L.push(...inGroupLines(ctx, m.t0, m.t1 + 1, {brief: true}));
        const quiet = samePlaces(ctx, m.t0, m.t1);
        if (lists.momentGroups) {
            L.push(quiet ? 'Groups, the same riders from start to end, with the gaps at both:' : 'At the start:',
                ...roadAt(ctx, m.t0, {...opts, until: quiet ? m.t1 : null}));
        }
        if (ctx.hasMoves && !quiet && lists.movesPerMoment) {
            const inside = moveEvents(ctx, m.t0, m.t1).filter(isNearMove);
            if (inside.length) {
                L.push('Changes of group:',
                    ...inside.slice(0, lists.movesPerMoment).map(e => `  ${moveLine(ctx, e, lists.moveNames)}`));
                if (inside.length > lists.movesPerMoment) {
                    L.push(`  and ${inside.length - lists.movesPerMoment} more changes, not listed.`);
                }
            } else {
                L.push('No rider changed group next to yours.');
            }
        }
        if (!quiet && lists.momentGroups) {
            L.push('At the end:', ...roadAt(ctx, m.t1, opts));
        }
        if (debrief) {
            // A moment holding one of the rider's hard efforts points at that effort's own cost
            // block rather than repeating a cost worked out over the wider window.
            if (m.efforts.length) {
                L.push(`What it cost you: see YOUR BIGGEST EFFORTS, ` +
                    `${m.efforts.map(e => fmtClock(e.start)).join(' and ')}.`);
            } else {
                L.push(`What it cost you: ${costBrief(ctx, m.t0, m.t1)}`);
            }
        }
        if (lists.momentRows) {
            L.push(...momentRows(ctx, m, {debrief, step: step * (m.changed ? 1 : 2)}));
        }
    });

    if (debrief) {
        section('YOUR RACE STRETCH BY STRETCH', ...stretchLines(ctx, {climbs, maxNames: Math.min(4, lists.moveNames)}));
    }

    section('WHO DID WHAT IN YOUR GROUP', ...inGroupSection(ctx));

    section('THE GROUPS ON THE ROAD', ...roadGroupsSection(ctx, {factor: lists.overviewFactor, maxEvents: lists.roadEvents}));

    section('TERRAIN', ...terrainLines(ctx, {maxRows: lists.terrainRows}));

    section('CLIMBS',
        'Stretches of 30 s or more at 3% or steeper, from Sauce\'s grade. A climb is named only where Sauce ' +
        'has a route segment for that road; banners and sprints are not in these facts. Groups as riders @ gap.',
        ...climbLines(ctx, climbs.slice(0, lists.climbs), {debrief, brief: lists.climbsBrief}),
        ...(climbs.length > lists.climbs ? [`${climbs.length - lists.climbs} more climbs, not listed.`] : []));

    const cutTimes = [...climbs.flatMap(c => [c.t0, c.t1 + 1]), ...efforts.flatMap(e => [e.start, e.end + 1])];
    section('HOW THE GAPS MOVED',
        'The gap to the nearest group ahead and behind, stretch by stretch, cut where that group changed ' +
        'or a climb or hard effort began or ended; the biggest changes, in time order. Rates come from ' +
        'Sauce\'s live gaps, so about, and say nothing about why.',
        ...gapStretchLines(ctx, cutTimes, {max: lists.gapLines}));

    // Only when the Zenmaster mod saved segment results for this race, or Zwift's segment times were
    // fetched with the official results (zenmaster.mjs).
    const sprints = segmentPointsLines(rec.segmentPoints, {includeNames, teamKey: tagKey,
        teamTag: options.teamTag ?? (rec.self && rec.self.team)});
    if (sprints.length) {
        section(segmentPointsTitle(rec.segmentPoints), ...sprints);
    }

    section('YOUR FINISH', ...finishLines(ctx, {officialResults: !!(rec.results && rec.results.length),
                                                maxNames: lists.finishNames}));

    if (debrief) {
        section('YOUR BIGGEST EFFORTS AND WHAT THEY COST',
            ctx.ftp ? 'In time order. Each is a run of 10 seconds or more where your 10 second average was ' +
                'at least 110 percent of FTP, the five biggest by work above FTP.' :
                'Your FTP is not known, so no hard efforts can be picked out.',
            ...(ctx.ftp && !efforts.length ? ['None in this race.'] : []),
            ...effortBlocks(ctx, efforts));
        L.push('', ...bestPowerLines(ctx, own, stats));
        section('POWERUPS ACTIVE ON YOU', ...powerUpLines(ctx));
        const earlier = (options.earlier || []).slice(0, lists.earlier);
        section('YOUR EARLIER RACES',
            earlier.length ?
                'Races recorded earlier on this computer, newest first, summarised with the same rules as ' +
                'this one. Routes, lengths and fields differ.' :
                'No earlier race recorded on this computer was given.',
            ...earlier.flatMap(x => earlierRaceLines(x, {units: U})));
    } else {
        // Between the key moments only: each moment lists its own.
        const outside = e => !moments.some(m => e.t >= m.t0 && e.t <= m.t1);
        const lines = ctx.hasMoves ? moveEvents(ctx, -Infinity, ctx.line).filter(isNearMove).filter(outside)
            .map(e => withoutBriefChanges(ctx, e)).filter(Boolean) : [];
        section('WHO WAS WHERE, BETWEEN THE KEY MOMENTS',
            ctx.hasMoves ?
                'Riders who moved between your group and the groups next to it outside the key moments ' +
                `(each lists its own), as Sauce saw it on the road. A rider back where they were within ` +
                `${BRIEF_CHANGE_SECONDS} s is left out.` :
                'Who was in the other groups was not recorded by the version of the mod that made this recording.',
            ...(ctx.hasMoves && !lines.length ? ['None.'] : []),
            ...lines.slice(0, lists.moveLines).map(e => moveLine(ctx, e, lists.moveNames)),
            ...(lines.length > lists.moveLines ? [`${lines.length - lists.moveLines} more, not listed.`] : []));
        const milestones = gapMilestoneLines(ctx, {max: lists.milestones});
        if (milestones.length) {
            L.push('', 'Gap milestones between groups:', ...milestones);
        }
        section('POWERUPS ACTIVE ON YOU', ...powerUpLines(ctx));
        section('RIDERS WHO SPENT TIME IN YOUR GROUP', ...companionLines(rec, model, shown, includeNames, lists.companions));
        const after = afterLineFacts(rec);
        if (after) {
            section('AFTER THE LINE', ...afterLineLines(after, shown, lists.arrivals));
        }
    }

    if (rec.results && rec.results.length) {
        section('OFFICIAL RESULTS AS ZWIFT RETURNED THEM');
        for (const r of rec.results.slice(0, lists.results)) {
            // Each rider's tag too, so the team's places can be read here (THE RIDER'S TEAM).
            const tag = includeNames && shortTag(r.team);
            L.push(`${r.place ?? '-'} ${nameOfResult(r)}${tag ? ` [${tag}]` : ''}` +
                `${r.timeSeconds != null ? ` ${fmtDuration(r.timeSeconds)}` : ''}` +
                `${r.avgWatts != null ? ` ${Math.round(r.avgWatts)} W` : ''}` +
                `${r.flags ? ` (${r.flags})` : ''}`);
        }
        if (rec.results.length > lists.results) {
            L.push(`${rec.results.length - lists.results} more, not listed.`);
        }
    }

    section('WHAT IS NOT KNOWN',
        ...model.cannot.map(x => `- ${stripCitations(x)}`),
        ...oncePerFact(model.notes, rec).map(x => `- ${stripCitations(x)}`),
        '- Where anyone sat inside a group: wheel order, and who was on the front.',
        '- Any other rider\'s own power, heart rate, W\'bal or effort.',
        ...(debrief ? ['- Anything about training, fitness or preparation. These facts cover this race only.'] : []));

    section('HOW THIS WAS COLLECTED',
        'Recorded by the Race Report mod for Sauce for Zwift, from data Sauce already had on this computer. ' +
        `Your own numbers are ${own.source === 'sauce-streams' ? "Sauce's own per-second record" :
            'a second by second copy the mod made while you rode'}.`,
        'Nothing was uploaded by the mod. Pasting this into an AI service sends it to that service under ' +
        `their terms${includeNames ? ', including the rider names in it.' : '.'}`);

    return tagOnce(L.join('\n'), Object.keys(allRiders).map(k => [nameOf(k), teamOf(k)]).filter(x => x[1]));
}


/* ------------------------------------------------------------------ sections both styles share */

function completenessLines(rec, model, own) {
    const L = [];
    const raceSeconds = model.meta.raceSeconds;
    const firstSecond = model.meta.firstSecond || 0;
    if (rec.clock === 'race') {
        L.push(`Times below are seconds from the gun. This record covers ${fmtClock(firstSecond)} ` +
            `to ${fmtClock(raceSeconds)} of the race.`);
        const joined = joinedLateSecond(rec);
        const clockLate = zwiftClockLate(rec);
        const lateBy = startedLateBy(rec);
        if (joined != null) {
            L.push(`The rider joined the event ${joined} seconds after the gun` +
                `${lateBy > 15 ? '' : ', so the record starts there'}. Say nothing about the race ` +
                `before that.`);
        }
        if (clockLate != null) {
            L.push(`${zwiftClockLateText(clockLate, 'the rider')}` +
                `${clockLate.seconds > 0 ? ` Sauce's own totals below start with that clock, at ` +
                `${fmtClock(clockLate.at)}, not with the gun.` : ''} No reason for this is known; ` +
                'do not suggest one.');
        }
        if (isNum(lateBy) && lateBy > 15) {
            L.push(`The recorder only started watching at ${fmtClock(rec.startedAtRaceSecond)}` +
                `${joined != null ? `, ${lateBy} seconds after the rider joined` : ''}, ` +
                `so every group, gap and rider fact below begins there. Say nothing about who was ` +
                `where before that.`);
        }
    } else {
        L.push('Times below are seconds from the moment recording started, not from a race start.');
    }
    const cov = rec.coverage;
    if (cov) {
        L.push(`Seconds recorded: ${cov.secondsRecorded} of the ${cov.spanSeconds} this record ` +
            `covers. Missing: ${cov.missingSeconds}` +
            `${cov.largestGapSeconds ? `, longest single gap ${cov.largestGapSeconds} s` : ''}.`);
    }
    if (rec.incomplete) {
        L.push(`This is NOT a complete record of the race: ${(rec.incompleteReasons || []).join('; ')}.`);
    } else {
        L.push(`This record ran from ${joinedLateSecond(rec) != null ? 'when the rider joined' :
            'the gun'} to the finish line with no material gaps.`);
    }
    if (own.source === 'sauce-streams') {
        // Sauce's record does not reach back to the gun (or the join) when Zwift's race clock
        // started late.
        const streamsFrom = own.t[own.rowsBeforeStreams || 0];
        const fromStart = streamsFrom - (joinedLateSecond(rec) ?? 0) <= ZWIFT_CLOCK_LATE_SECONDS;
        L.push("The rider's own power, heart rate, speed and draft below are Sauce's own " +
            `${fromStart ? 'complete per-second record of the race' :
                `per-second record, which begins at ${fmtClock(streamsFrom)}`}. The group and ` +
            'gap numbers are this mod\'s own and can have gaps where the window missed seconds.');
        if (own.rowsBeforeStreams) {
            L.push(`Sauce's own record starts at ${fmtClock(own.t[own.rowsBeforeStreams])}; before ` +
                'that the rider\'s own numbers are the mod\'s second by second copy.');
        }
    }
    if (!(rec.moves && Array.isArray(rec.moves.t))) {
        L.push('This recording was made by a version of the mod that did not keep who was in the other ' +
            'groups, so the groups ahead and behind appear only as sizes and gaps.');
    }
    return L;
}

function wholeRaceLines(rec, own, stats, U, model) {
    const L = [];
    if (stats) {
        L.push(`Elapsed: ${fmtDuration(stats.elapsedTime)}   Active: ${fmtDuration(stats.activeTime)}`);
        if (stats.power) {
            L.push(`Power: ${num(stats.power.avg)} W average, ${num(stats.power.np)} W normalised, ` +
                `${num(stats.power.max)} W max, ${num(stats.power.kj)} kJ` +
                `${isNum(stats.power.tss) ? `, ${Math.round(stats.power.tss)} TSS` : ''}`);
            // Sauce's peaks are under YOUR BIGGEST EFFORTS, once, with when each started.
        }
        if (stats.hr && isNum(stats.hr.avg)) {
            L.push(`Heart rate: ${num(stats.hr.avg)} bpm average, ${num(stats.hr.max)} bpm max`);
        }
        if (stats.speed && isNum(stats.speed.avg)) {
            L.push(`Speed: ${U.speed(stats.speed.avg)} average`);
        }
        if (stats.cadence && isNum(stats.cadence.avg)) {
            L.push(`Cadence: ${num(stats.cadence.avg)} rpm average`);
        }
        if (stats.draft && isNum(stats.draft.avg)) {
            L.push(`Draft benefit: ${num(stats.draft.avg)} W average` +
                `${isNum(stats.draft.kj) ? `, ${num(stats.draft.kj)} kJ` : ''}`);
        }
        L.push(`Time in a group with draft: ${fmtDuration(stats.followTime)} (${num(stats.followKj)} kJ)`);
        L.push(`Time in a group with no draft: ${fmtDuration(stats.workTime)} (${num(stats.workKj)} kJ)`);
        L.push(`Time with no group at all: ${fmtDuration(stats.soloTime)} (${num(stats.soloKj)} kJ)`);
        L.push('"In a group with no draft" is not the same as "on the front": a rider in the wind ' +
            'at the side of a bunch reads the same way.');
    } else {
        const w = sliceStats(own.t, own.power, model.meta.firstSecond || 0, model.meta.raceSeconds ?? 1e9);
        L.push(`Power: ${w ? `${Math.round(w.avg)} W average, ${Math.round(w.max)} W max` : 'not known'}`);
        L.push("Sauce's own follow, work and solo split was not available for this recording.");
    }
    return L;
}

function companionLines(rec, model, shown, includeNames, max) {
    const L = [];
    // From the membership log when there is one: a rider Sauce showed a few tenths outside the
    // group for a payload was still in it (companionsFromLog in report.mjs).
    const comps = companionsFromLog(rec, model.meta.raceSeconds, model.meta.firstSecond || 0) ||
        companions(rec.riders, model.meta.raceSeconds, model.meta.firstSecond || 0);
    L.push(comps.length ? 'Time each spent in your group; "to the end" means still in it at the line.' : 'None recorded.');
    for (const c of comps.slice(0, max)) {
        L.push(`${shown(c.id, c.name)}: ${fmtDuration(c.seconds)}${c.toTheEnd ? ', to the end' : ''}`);
    }
    if (comps.length > max) {
        L.push(`${comps.length - max} more riders spent less time in your group.`);
    }
    if (includeNames) {
        const unnamed = comps.filter(x => !x.named).length;
        if (unnamed) {
            L.push(`${unnamed} of these reached the recorder with no name and keep their "Rider" ` +
                `label, which is good for this race only.`);
        }
    }
    return L;
}

function afterLineLines(after, shown, maxArrivals) {
    const L = [];
    L.push(`Watched for ${after.captured} s after you crossed at ${fmtClock(after.finish)}; nothing above ` +
        'includes this time.');
    if (after.endedBy && after.endedBy !== 'time' && after.captured < after.requested) {
        L.push(`It stopped after ${after.captured} s of the ${after.requested} s asked for, ` +
            `because ${afterLineEndedText(after.endedBy)}.`);
    }
    L.push('Exact finish times and places come from the official results, not from this section.');
    if (!after.watchingSelf) {
        L.push('For part of this time Sauce was watching another rider, so the gaps describe ' +
            'the road around that rider.');
    }
    if (after.onClock) {
        L.push('This event ended on the clock, so it ended for every rider at the same moment ' +
            'and nobody can be seen coming in after the rider.');
        if (!after.behindAtClock.length) {
            L.push('When the clock ran out nobody came into view behind the rider (Sauce only ' +
                'places riders on the last few roads the rider rode).');
        } else {
            L.push(`Riders of this event behind the rider on the road when the clock ran out: ` +
                `${after.behindAtClock.length}`);
            L.push('The gaps are Sauce\'s live road gaps and can be a second or so out.');
            for (const x of after.behindAtClock.slice(0, maxArrivals)) {
                L.push(`${shown(x.key, x.name)}: ${x.gap.toFixed(1)} s behind`);
            }
        }
    } else if (!after.arrivals.length && !after.seenBehind) {
        L.push('In this time nobody came into view behind the rider (Sauce only places riders ' +
            'on the last few roads the rider rode).');
    } else if (!after.arrivals.length && !after.ridersReportedFinish) {
        L.push(`Riders in view behind the rider: ${after.seenBehind}. Sauce did not say ` +
            'whether any of them reached the line, so none are counted in.');
    } else if (!after.arrivals.length) {
        L.push(`Riders in view behind the rider: ${after.seenBehind}. None reached the line in this time.`);
    } else {
        L.push(`Riders who reached the line behind the rider in this time: ${after.arrivals.length}`);
        L.push('Gaps are Sauce\'s live gaps as each reached the line; riders within 2 s of the one before ' +
            'are one group.');
        for (const g of after.groups.slice(0, maxArrivals)) {
            const first = g.riders[0];
            const last = g.riders[g.riders.length - 1];
            L.push(g.riders.length === 1 ?
                `${shown(first.key, first.name)}: came in at ${fmtClock(first.t)}, ${first.gap.toFixed(1)} s behind` :
                `A group of ${g.riders.length} came in ${first.gap.toFixed(1)} to ${last.gap.toFixed(1)} s ` +
                `behind, ${first.t === last.t ? `at ${fmtClock(first.t)}` : `${fmtClock(first.t)} to ${fmtClock(last.t)}`}: ` +
                `${g.riders.slice(0, 12).map(x => shown(x.key, x.name)).join(', ')}` +
                `${g.riders.length > 12 ? ` and ${g.riders.length - 12} more` : ''}`);
        }
        for (const g of after.groups) {
            if (g.closedBy == null) {
                continue;
            }
            L.push(`${g.riders.length === 1 ? 'Rider' : `Group of ${g.riders.length}`} ` +
                `(${g.riders.slice(0, 8).map(x => shown(x.key, x.name)).join(', ')}` +
                `${g.riders.length > 8 ? ` and ${g.riders.length - 8} more` : ''}): first seen ` +
                `${g.firstSeenGap.toFixed(1)} s behind after the line, at ` +
                `${fmtClock(g.firstSeenT)}, came in ${g.riders[0].gap.toFixed(1)} s behind, ` +
                `${g.closedBy.toFixed(1)} s closer`);
        }
    }
    // How many were still out is in YOUR FINISH.
    return L;
}

/*
 * Best power inside the race, once. Where Sauce has a peak for a period, Sauce's own figure is the
 * one given, because it is the one Sauce shows, starting where Sauce's own peak time puts it
 * (saucePowerPeaks). Without that time, the start is that of the rows' best window when the two
 * agree to within 3%, and not given when they do not. A period Sauce has no peak for comes from the
 * rows. On Van's 16 Sep 2026 recording the debrief gave Sauce's 5 s peak as 95 W and, a few
 * sections later, the rows' best 5 s as 104 W, from a "5 s" window of four samples.
 */
function bestPowerLines(ctx, own, stats) {
    const sauce = saucePowerPeaks({...ctx.rec, stats});
    const idx = own.t.map((t, i) => i).filter(i => own.t[i] <= ctx.line);
    const L = [sauce.size ?
        'Best power inside the race, Sauce\'s own peaks where it has them, with when each started:' :
        'Best power inside the race, from the rows, with when each started:'];
    for (const period of [...new Set([5, 15, 60, 300, ...sauce.keys()])].sort((a, b) => a - b)) {
        const b = bestOf(own, idx, period);
        const sp = sauce.get(period);
        const s = sp && sp.avg;
        const avg = isNum(s) ? s : b && b.avg;
        if (!isNum(avg)) {
            continue;
        }
        const start = sp && isNum(sp.startT) ? sp.startT :
            b && (!isNum(s) || Math.abs(b.avg - s) <= 0.03 * s) ? b.startT : null;
        L.push(`  ${period} s: ${Math.round(avg)} W${wkg(ctx, avg) ? ` (${wkg(ctx, avg)})` : ''}` +
            `${isNum(s) ? ', Sauce\'s peak' : ''}` +
            (isNum(start) ?
                ` from ${fmtClock(start)}, your group ${ctx.P.size.at(start, ctx.packNear) ?? '?'} riders.` :
                ', when it started is not known.'));
    }
    return L.length > 1 ? L : [];
}

/*
 * The best average of `period` seconds among the rows at `idx`, from windows that hold a row for
 * nearly every second of it: a window with seconds missing is not a `period` second average.
 */
function bestOf(own, idx, period) {
    // Averaged over time, from windows with nearly every second in them (bestWindow in report.mjs).
    const b = bestWindow(idx.map(k => own.tExact[k]), idx.map(k => own.power[k]), period, {minCover: 0.95});
    return b && {avg: b.avg, startT: own.t[idx[b.i]]};
}


/*
 * Some facts reach the report's notes twice: the recorder writes a note as the thing happens, and
 * buildReport adds its own wording of the same fact for the window. On Van's session of
 * 16 Sep 2026 the sampling rate was listed four times in two wordings, and "started by hand" twice.
 * "Not a complete record" is also said once already, under HOW COMPLETE THIS RECORD IS. Each fact
 * is kept once here, in the first wording that carries it, which is the recorder's. Anything that
 * matches none of these is kept unless it is word for word a line already kept.
 */
const NOTE_FACTS = [
    ['incomplete', /^This is not a complete record of the race/i],
    ['pack-interval', /the group around you (?:dropped from|was recorded) every/],
    ['self-interval', /your own numbers (?:dropped from|were recorded) every/],
    ['manual-start', /^(?:Started by hand|This recording was started by hand)/],
];

function oncePerFact(notes, rec) {
    const seen = new Set(rec.incomplete ? ['incomplete'] : []);
    const out = [];
    for (const x of notes || []) {
        const fact = NOTE_FACTS.find(([, re]) => re.test(String(x)));
        const key = fact ? fact[0] : `text:${x}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        out.push(x);
    }
    return out;
}


function num(x) {
    return isNum(x) ? Math.round(x) : 'not known';
}

function lastNum(arr) {
    if (!Array.isArray(arr)) {
        return null;
    }
    for (let i = arr.length - 1; i >= 0; i--) {
        if (isNum(arr[i])) {
            return arr[i];
        }
    }
    return null;
}

function stripCitations(s) {
    return String(s).replace(/\s*\((?:src\/|pages\/)[^)]*\)/g, '');
}
