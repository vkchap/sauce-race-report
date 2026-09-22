/*
 * Race Report - tests that can run without Zwift.
 *
 *   node test/run-tests.mjs
 *
 * WHAT THIS FILE DOES: exercises everything in the mod that does not need Sauce, Electron or
 * Zwift, against the synthetic feed in synthetic-feed.mjs.
 *
 *   1. The manifest validates against the schema Sauce applies to it, and every path it names
 *      exists on disk. If a copy of the Sauce source is present, the manifest is ALSO run through
 *      Sauce's own validateMod, so the schema is not just a paraphrase.
 *   2. Every JavaScript file parses, the pure ones import cleanly, and nothing anywhere reaches
 *      for the network.
 *   3. The recorder against a synthetic race: it stays idle in the start pen, starts at the gun,
 *      records the pack, stops at the finish, survives a hidden window and a Sauce restart, and
 *      handles the five ways a race can go wrong.
 *   4. What it stores is within what Sauce itself stores: no rider id for a rider Sauce could not
 *      name, no avatar, country, weight or FTP for anyone but the rider, and a team tag only as
 *      Sauce reads it out of a name it shows.
 *   5. The report and the fact pack are produced, say plainly how complete the recording was,
 *      contain no training advice, and do not claim to know why anyone did anything.
 *   6. After the line: an automatic recording keeps watching the riders behind come in for the
 *      time the setting gives, Stop and leaving the event end that at once, and every number
 *      about the race itself is the same whether the extra time was recorded or not.
 *   7. The gun: times count from the category's scheduled start even when Zwift's own race clock
 *      starts late, nothing is recorded in the pen before it, late joins, an unknown scheduled
 *      start, a computer clock that is off, and the shapes of the real recording of 16 Sep 2026.
 *   8. Storage: recordings and the crash snapshot go to IndexedDB (an in-memory fake here,
 *      fake-indexeddb.mjs), with a localStorage fallback under keys Sauce's windows ignore, and
 *      nothing, the settings included, under a "/" key; races an earlier version saved, and races
 *      saved while IndexedDB would not open, move in without loss, the old copies removed only by
 *      a later start; the snapshot is written in pieces, reads back whole after a restart, during
 *      the extra time and after a move onto the gun, survives a failed save and a second window,
 *      and stays small in a big field; a three hour race keeps every second; and the fact pack's
 *      heading, notes and coverage agree.
 *   9. The two copied texts, race commentary and coach's debrief: the membership log of who was in
 *      the other groups, which records no flicker in a big field that flickers; splits that must
 *      hold; key moments by fixed rules; climbs, gaps, the rider's finish, powerups, efforts and
 *      earlier races; team tags and the group's average power as Sauce shows them; the size of
 *      each text on a normal race and on a long one with many moments; no em dashes; and the two
 *      buttons in the window.
 *
 * What is NOT covered here, and cannot be until a real race: see the end of this file, which
 * prints the list.
 */

import * as FS from 'node:fs';
import * as Path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

import {Recorder, Roster, activeEventSlice, isSelfPayload, isPastEventEnd, hasUnknownEventEnd,
        isRaceLike, eventBlocksRecording, computeCoverage, applyIncompleteness, withAfterLine,
        serverClockOffset, MOD_VERSION, MIN_SAUCE_VERSION, MAX_AFTER_LINE_SECONDS,
        ZWIFT_EPOCH_MS} from '../src/recorder.mjs';
import {Store, MemoryAdapter, MemoryStorage, LocalStorageKV, LegacyStorage, LegacySource, LocalSettings,
        openStore, summarize, splitSnapshot, joinSnapshot, indexedDBBudgets, DEFAULT_SETTINGS,
        LOCAL_BUDGETS, LOCAL_PREFIX, LOCAL_PIECE_CHARS, IDB_FIXED_BUDGETS, DB_NAME, KEY_INDEX,
        KEY_LIVE, KEY_PENDING, KEY_SETTINGS, LEGACY_KEY_SETTINGS, keyForRecording} from '../src/store.mjs';
import {buildReport, renderReportHTML, findSplits, companions, ridersWhoLeft,
        bestWindow, ownSeries, fmtClock, prettyPowerUp, SPLIT_HOLD_SECONDS, splitSizes, resultsErrorText} from '../src/report.mjs';
import {buildFactPack, PROMPTS, MAX_EARLIER_RACES, HARD_CAP_CHARACTERS, isEarlierRace, shortTag, tagOnce} from '../src/factpack.mjs';
import {withoutBriefChanges, raceContext, findMoments} from '../src/racefacts.mjs';
import {segmentPointsFrom, segmentPointsLines, segmentPointsFromZwift} from '../src/zenmaster.mjs';
import {FakeClock, runSyntheticRace, makeSelfPayload, makeGroupsPayload, makeEventInfo,
        makeEventSliceStatsV1, makeStreams, fakeGetAthletes, runLineFinish, runGunRace,
        gunRacePowerAt, gunStreamTime, SELF_ID, SYNTHETIC_END_DISTANCE, GUN_SERVER_MS,
        GUN_CREATED_SERVER_MS, runLongRace, makeLongEventInfo, makeLongRaceStats, LONG_RACE_SEGMENTS, seeded} from './synthetic-feed.mjs';
import {MOVE_HOLD_SECONDS, SAME_SIDE_HOLD_FACTOR} from '../src/recorder.mjs';
import {FakeIndexedDB} from './fake-indexeddb.mjs';

const HERE = Path.dirname(fileURLToPath(import.meta.url));
const MOD_DIR = Path.resolve(HERE, '..');

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch(e) {
        failures.push([name, e]);
        console.log(`  FAIL ${name}\n         ${e.message}`);
    }
}

/* The same, for a test that has to wait for the store. Called with await, so tests stay in order. */
async function checkAsync(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok   ${name}`);
    } catch(e) {
        failures.push([name, e]);
        console.log(`  FAIL ${name}\n         ${e.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) {
        throw new Error(msg || 'assertion failed');
    }
}

function assertEq(a, b, msg) {
    if (a !== b) {
        throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    }
}

function section(title) {
    console.log(`\n${title}`);
}


/* ================================================================= 1. the manifest */

/*
 * A transcription of Sauce's manifest schema, src/mods-core.mjs:33-81 in v2.3.0, which is byte
 * identical on the main branch. Kept here so the test runs with no Sauce source present.
 */
const isSafePath = x => !!x.match(/^[a-z0-9]+[a-z0-9_\-./]*$/i) && !x.match(/\.\./);
const isSafeID = x => !!x.match(/^[a-z0-9-_]+$/i);

const MANIFEST_SCHEMA = {
    manifest_version: {type: 'number', required: true, valid: x => x === 1},
    id: {type: 'string', valid: isSafeID},
    name: {type: 'string', required: true},
    description: {type: 'string', required: true},
    version: {type: 'string', required: true},
    author: {type: 'string'},
    website_url: {type: 'string'},
    web_root: {type: 'string', valid: isSafePath},
    content_js: {type: 'string', isArray: true, valid: isSafePath},
    content_css: {type: 'string', isArray: true, valid: isSafePath},
    windows: {
        type: 'object',
        isArray: true,
        schema: {
            file: {type: 'string', required: true, unique: true, valid: isSafePath},
            query: {type: 'object', schema: {'*': {type: 'string'}}},
            id: {type: 'string', required: true, unique: true},
            name: {type: 'string', required: true, unique: true},
            description: {type: 'string'},
            always_visible: {type: 'boolean', deprecated: true},
            overlay: {type: 'boolean'},
            frame: {type: 'boolean'},
            default_bounds: {
                type: 'object',
                schema: {
                    width: {type: 'number', valid: x => x >= 0},
                    height: {type: 'number', valid: x => x >= 0},
                    x: {type: 'number'},
                    y: {type: 'number'},
                    // Declared boolean, validated x > 0, so only `true` can ever pass
                    // (src/mods-core.mjs:75-76). A mod cannot set a real aspect ratio.
                    aspect_ratio: {type: 'boolean', valid: x => x > 0},
                },
            },
        },
    },
};

function validateSchema(obj, schema, _path = [], _unique, _warnings = []) {
    if (typeof obj !== 'object') {
        throw new Error('Invalid manifest root type: expected object');
    }
    const required = new Set(Object.entries(schema).filter(([, x]) => x.required).map(([k]) => k));
    for (const [k, v] of Object.entries(obj)) {
        if (!schema['*'] && !Object.prototype.hasOwnProperty.call(schema, k)) {
            throw new Error(`Unexpected key: ${[..._path, k].join('.')}`);
        }
        const info = schema[k] || schema['*'];
        if (info.isArray && !Array.isArray(v)) {
            throw new Error(`Invalid type for ${k}, expected array`);
        }
        const vUnique = info.schema && new Map(Object.entries(info.schema)
            .filter(([, x]) => x.unique).map(([kk]) => [kk, new Set()]));
        for (const [i, xv] of (info.isArray ? v : [v]).entries()) {
            const pathKey = info.isArray ? `${k}[${i}]` : k;
            if (info.deprecated) {
                _warnings.push(`Deprecated field "${[..._path, pathKey].join('.')}"`);
            }
            if (typeof xv !== info.type) {
                throw new Error(`Invalid type for ${pathKey}, expected ${info.type}`);
            }
            if (info.valid && !info.valid(xv)) {
                throw new Error(`Invalid value for ${pathKey}: ${xv}`);
            }
            if (info.schema) {
                validateSchema(xv, info.schema, [..._path, pathKey], vUnique, _warnings);
            }
            if (_unique && _unique.has(k)) {
                const used = _unique.get(k);
                if (used.has(xv)) {
                    throw new Error(`Duplicate unique value for ${pathKey}: ${xv}`);
                }
                used.add(xv);
            }
        }
        required.delete(k);
    }
    if (required.size) {
        throw new Error(`Missing required key(s): ${[...required]}`);
    }
    return _warnings;
}

const manifest = JSON.parse(FS.readFileSync(Path.join(MOD_DIR, 'manifest.json'), 'utf8'));

section('1. the manifest, against the schema Sauce applies (src/mods-core.mjs:33-81)');

check('manifest validates, with no deprecation warnings', () => {
    const warnings = validateSchema(manifest, MANIFEST_SCHEMA);
    assertEq(warnings.length, 0, `unexpected warnings: ${warnings.join(', ')}`);
});

check('manifest_version is exactly 1', () => assertEq(manifest.manifest_version, 1));

check('every path the manifest names exists on disk', () => {
    // Sauce pushes an FS.realpathSync validator onto the safe-path check for unpacked mods
    // (src/mods.mjs:29-31). A missing file makes the whole mod disappear from the Mods list.
    const paths = [
        ...(manifest.content_js || []),
        ...(manifest.content_css || []),
        ...(manifest.web_root ? [manifest.web_root] : []),
        ...manifest.windows.map(x => x.file),
    ];
    for (const p of paths) {
        assert(FS.existsSync(Path.join(MOD_DIR, p)), `missing: ${p}`);
    }
});

check('the report window has a frame, so it has a title bar and a close button', () => {
    // Without frame:true Sauce builds a frameless transparent window (src/windows.mjs:1463-1477).
    assertEq(manifest.windows[0].frame, true);
});

check('the report window sets overlay:false, so the hide-overlays hotkey cannot hide it', () => {
    // canToggleVisibility returns spec.overlay !== false for a mod window
    // (src/windows.mjs:551-557). A hidden window suspends non-persistent subscriptions.
    assertEq(manifest.windows[0].overlay, false);
});

check('no web_root, so nothing this mod holds is served on Sauce\'s local web server', () => {
    // web_root publishes files on a server that binds 0.0.0.0 with CORS * (src/webserver.mjs:
    // 497-541, :576, :380). Recordings must never be reachable that way.
    assert(manifest.web_root === undefined, 'web_root is set');
});

check('no content_js and no content_css, so this mod runs no code in other windows', () => {
    // content_js from every enabled mod executes in EVERY internal Sauce window
    // (src/mods.mjs:149-157, src/preload/common.js:39-44).
    assert(manifest.content_js === undefined, 'content_js is set');
    assert(manifest.content_css === undefined, 'content_css is set');
});

check('the mod version in the manifest matches the one the recorder stamps on a recording', () => {
    assertEq(manifest.version, MOD_VERSION);
});

check('website_url is left unset rather than pointing at a page that does not exist', () => {
    // The store's release tool maps its Home URL field to this. Setting it to an invented address
    // would be worse than leaving it out; see the submission checklist in spec/build-plan.md.
    assert(manifest.website_url === undefined || /^https?:\/\/\S+$/.test(manifest.website_url),
           'website_url is set to something that is not a URL');
});

const SAUCE_SRC = process.env.SAUCE_SRC ||
    '/private/tmp/claude-501/-Users-vanchappell-Desktop-claude-cycling-app/' +
    '14e5a418-d0f4-4354-ae91-94ca507d0b73/scratchpad/s4z-2.3.0';
const sauceCore = Path.join(SAUCE_SRC, 'src/mods-core.mjs');
if (FS.existsSync(sauceCore)) {
    const Core = await import(`file://${sauceCore}`);
    check("Sauce's own validateMod accepts the manifest (v2.3.0 source)", () => {
        const {warnings} = Core.validateMod({manifest, modPath: MOD_DIR});
        assertEq(warnings.length, 0, `warnings: ${warnings.join(', ')}`);
    });
    check("Sauce's own validateMod rejects a manifest with an unknown key", () => {
        let threw = false;
        try {
            Core.validateMod({manifest: {...manifest, webPreferences: {}}, modPath: MOD_DIR});
        } catch(e) {
            threw = e.message.includes('Unexpected key');
        }
        assert(threw, 'expected an Unexpected key error');
    });
} else {
    console.log('  skip Sauce\'s own validateMod (set SAUCE_SRC to a v2.3.0 checkout to run it)');
}


/* ================================================================= 2. every file parses */

section('2. every file parses and nothing reaches for the network');

const jsFiles = ['src/recorder.mjs', 'src/store.mjs', 'src/report.mjs', 'src/factpack.mjs',
                 'src/racefacts.mjs', 'src/zenmaster.mjs', 'src/ui.mjs', 'test/synthetic-feed.mjs', 'test/fake-indexeddb.mjs',
                 'test/run-tests.mjs'];
for (const f of jsFiles) {
    check(`${f} parses`, () => {
        execFileSync(process.execPath, ['--check', Path.join(MOD_DIR, f)], {stdio: 'pipe'});
    });
}

check('the page loads only its own files and Sauce\'s page library', () => {
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    const srcs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(x => x[1]);
    for (const s of srcs) {
        assert(!s.startsWith('http'), `page references the network: ${s}`);
    }
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    const imports = [...ui.matchAll(/from\s+'([^']+)'/g)].map(x => x[1]);
    for (const i of imports) {
        assert(i.startsWith('./') || i === '/pages/src/common.mjs',
               `ui.mjs imports something unexpected: ${i}`);
    }
});

check('the page declares the same CSP Sauce\'s own pages declare, not a stricter invented one', () => {
    // Sauce imposes no policy on a mod page, so the page sets its own. Matching Sauce exactly
    // (pages/logs.html:7) is the only version known to work on the file:// origin these pages are
    // served from; a stricter one could block the module import and stop the mod dead.
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    const m = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
    assert(m, 'no CSP declared');
    assertEq(m[1].trim(), "script-src 'self' 'unsafe-inline';");
});

check('nothing outside ui.mjs imports Sauce or touches the DOM', () => {
    for (const f of ['src/recorder.mjs', 'src/store.mjs', 'src/report.mjs', 'src/factpack.mjs']) {
        const s = FS.readFileSync(Path.join(MOD_DIR, f), 'utf8');
        const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        assert(!code.includes('/pages/src/common.mjs'), `${f} imports Sauce`);
        assert(!/\bdocument\./.test(code), `${f} touches the DOM`);
        assert(!/\bfetch\s*\(/.test(code), `${f} calls fetch`);
        assert(!/\bXMLHttpRequest\b|\bWebSocket\b|\bnavigator\b/.test(code),
               `${f} reaches for the network`);
    }
});

check('no file anywhere in the mod contains an http or https URL to call out to', () => {
    for (const f of [...jsFiles, 'race-report.html', 'race-report.css', 'manifest.json']) {
        const s = FS.readFileSync(Path.join(MOD_DIR, f), 'utf8');
        // The manifest's website_url is the mod's home page, shown by Sauce, never called by the mod.
        const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '')
            .replace(/"website_url":\s*"[^"]*"/, '');
        const hits = [...code.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(x => x[0]);
        assert(!hits.length, `${f}: ${hits.join(', ')}`);
    }
});

check('the window never asks a question with window.confirm or window.alert', () => {
    // A mod page is a sandboxed Electron renderer and Sauce itself never uses either, so both
    // deletes ask in the page instead.
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/\bconfirm\s*\(/.test(ui.replace(/askInPage|pendingConfirm|#confirm[\w-]*/g, '')),
           'ui.mjs calls window.confirm');
    assert(!/\balert\s*\(/.test(ui), 'ui.mjs calls window.alert');
});

check('a hidden banner stays hidden even though .banner sets display', () => {
    // 17 Sep 2026: every banner showed at once, empty, because .banner {display: flex} beat the
    // browser's own [hidden] rule.
    const css = FS.readFileSync(Path.join(MOD_DIR, 'race-report.css'), 'utf8');
    assert(/\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/.test(css), 'no [hidden] rule');
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    assert(/class="banner[^"]*"\s+hidden/.test(html), 'banners are no longer hidden by attribute');
});

check('the results error from Sauce 2.3.x says to try again, and when', () => {
    // The message seen for real on 17 Sep 2026, thrown at src/stats.mjs:1515 in Sauce v2.3.0.
    const sauce = "Cannot read properties of null (reading 'id')";
    const now = Date.UTC(2026, 8, 17, 7, 45);
    const later = resultsErrorText(sauce, Date.UTC(2026, 8, 17, 8, 2), now);
    assert(/try again after .+when Sauce counts the event as over/.test(later), later);
    assert(!/TypeError|reading 'id'/.test(later), later);
    assert(/try again in a few minutes/.test(resultsErrorText(sauce, null, now)));
    assert(/try again in a few minutes/.test(resultsErrorText(sauce, now - 1000, now)));
    assertEq(resultsErrorText('HTTP 500', null, now), 'Zwift did not return results: HTTP 500');
    assert(!/—/.test(later), 'em dash');
});


/* ================================================================= 3. the recorder */

section('3. the recorder against a synthetic race');

function recordSynthetic(opts = {}) {
    const clock = new FakeClock();
    const finished = [];
    const rec = new Recorder({
        now: () => clock.now(),
        onFinalized: r => finished.push(r),
        ...opts,
    });
    runSyntheticRace(rec, clock, opts);
    return {recorder: rec, clock, finished};
}

const run = recordSynthetic();
const RACE = run.finished[0];

check('nothing is recorded while the rider is in the start pen', () => {
    // The pen runs 180 s with state.time zero. If the mod started there, the recording would be
    // 180 s longer than the race.
    assert(RACE, 'no recording was produced');
    assert(Math.abs(RACE.elapsedSeconds - 1501) <= 2,
           `elapsed was ${RACE.elapsedSeconds}, expected about 1501`);
});

check('the recording starts by itself and stops at the finish', () => {
    assertEq(RACE.trigger, 'auto');
    assertEq(RACE.stopReason, 'finish');
    assertEq(RACE.incomplete, false, `incomplete because: ${RACE.incompleteReasons.join('; ')}`);
});

check('times in the recording are seconds from the gun, not from the window', () => {
    assertEq(RACE.clock, 'race');
    assertEq(RACE.startedAtRaceSecond, 1, 'the gun offset is wrong');
    assertEq(RACE.timeline.t[0], 1);
    assertEq(RACE.timeline.t[RACE.timeline.t.length - 1], 1500);
});

check('the recording knows how much of the race it actually holds', () => {
    const cov = RACE.coverage;
    assertEq(cov.startSecond, 1);
    assertEq(cov.endSecond, 1500);
    assertEq(cov.spanSeconds, 1500);
    assertEq(cov.rowsRecorded, 1500);
    assertEq(cov.missingSeconds, 0);
    assertEq(cov.gaps.length, 0);
});

check('one row per second of the rider\'s own numbers', () => {
    assert(RACE.counts.selfRows >= 1495 && RACE.counts.selfRows <= 1502,
           `selfRows was ${RACE.counts.selfRows}`);
    assertEq(RACE.timeline.t.length, RACE.timeline.power.length);
    assertEq(RACE.timeline.t.length, RACE.timeline.wbal.length);
});

check('one row every two seconds of pack context, which halves the size of a recording', () => {
    assert(RACE.counts.packRows >= 740 && RACE.counts.packRows <= 760,
           `packRows was ${RACE.counts.packRows}`);
    assertEq(RACE.pack.t.length, RACE.pack.myGroupSize.length);
    assertEq(RACE.degraded.packRowInterval, 2);
});

check('a normal race fits inside the storage budget with room to spare', () => {
    // The pool is shared with Sauce's own settings, so this is the number that matters.
    const bytes = JSON.stringify(RACE).length;
    assert(bytes < 400_000, `a 25 minute race is ${Math.round(bytes / 1024)} kB`);
    assert(bytes > 20_000, `a 25 minute race is only ${bytes} bytes, something is missing`);
});

check('the riders around the rider are all recorded, named from Sauce\'s local profiles', () => {
    // 12 named plus 1 Sauce cannot name in the bunch, 2 more in the group behind.
    assertEq(RACE.counts.riders, 15);
    assertEq(RACE.counts.anonymousRiders, 1);
});

check('the powerups that were active are recorded as transitions, not per second', () => {
    const used = RACE.timeline.powerUpEvents.filter(x => x[1]);
    assertEq(used.length, 2, JSON.stringify(RACE.timeline.powerUpEvents));
    assertEq(used[0][1], 'FEATHER');
    assertEq(used[1][1], 'AERO');
});

check('the split is found, with the riders who were no longer in the group', () => {
    const splits = findSplits(RACE.pack);
    assert(splits.length >= 1, 'no split found');
    const sp = splits[0];
    assert(sp.t0 <= 620 && sp.t1 >= 620, `split window ${sp.t0}-${sp.t1} misses 620`);
    assertEq(sp.before - sp.after, 4);
    const left = ridersWhoLeft(RACE.riders, sp.t0, sp.t1);
    assertEq(left.length, 4);
    assert(left.some(x => x.name === 'Rider A'),
           'the rider Sauce could not name is missing from the split');
    assert(left.filter(x => x.name.startsWith('Racer ')).length === 3,
           'the named riders are missing from the split');
});

check('riders who stayed to the end are marked as such', () => {
    const comps = companions(RACE.riders, 1500, 1);
    const toEnd = comps.filter(x => x.toTheEnd);
    assert(toEnd.length >= 9, `only ${toEnd.length} riders were still there at the end`);
});

function packIndexNear(pack, t) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < pack.t.length; i++) {
        const d = Math.abs(pack.t[i] - t);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

check('riders ahead counts riders in OTHER groups, not the rider\'s own bunch', () => {
    // Counting by the sign of the gap would report every rider in front of you inside your own
    // bunch, because within-group gaps are fractions of a second and half of them are negative.
    const i = packIndexNear(RACE.pack, 300);
    assertEq(RACE.pack.ridersAheadOtherGroups[i], 0,
             'riders in the rider\'s own group are being counted as up the road');
    assertEq(RACE.pack.ridersBehindOtherGroups[i], 2, 'the chase group behind is not counted');
    const j = packIndexNear(RACE.pack, 700);
    assertEq(RACE.pack.ridersAheadOtherGroups[j], 4, 'the break up the road is not counted');
});

check('the manual start and stop work when nothing is happening', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x)});
    assertEq(r.startManual(), true);
    assertEq(r.state, 'recording');
    for (let t = 1; t <= 30; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({
            t, stateTime: t, eventSubgroupId: undefined, power: 200, hr: 140, cadence: 85,
            speed: 32, draft: 0, distance: t * 9, eventDistance: undefined, grade: 0,
            wBal: 19000, activePowerUp: null, endDistance: undefined, remainingType: 'route',
        }));
    }
    clock.t += 1000;
    assertEq(r.stopManual(), true);
    assertEq(finished.length, 1);
    assertEq(finished[0].trigger, 'manual');
    assertEq(finished[0].stopReason, 'manual');
    assertEq(finished[0].clock, 'wall', 'a manual recording outside an event took the race clock');
    assert(finished[0].counts.selfRows >= 29, 'manual recording captured nothing');
});

check('a recording started by hand is NOT stopped by an event finishing', () => {
    // This is what the window promises under "How this works", so it had better be true.
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x)});
    r.startManual();
    const base = {power: 250, hr: 160, cadence: 85, speed: 40, draft: 20, grade: 0, wBal: 18000,
                  activePowerUp: null, endDistance: SYNTHETIC_END_DISTANCE};
    for (let t = 1; t <= 20; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({...base, t, stateTime: t, eventSubgroupId: 999,
                                  distance: t * 11, eventDistance: t * 11}));
    }
    // Past the line.
    clock.t += 1000;
    r.onSelf(makeSelfPayload({...base, t: 21, stateTime: 21, eventSubgroupId: 999,
                              distance: 99999, eventDistance: SYNTHETIC_END_DISTANCE + 10}));
    assertEq(finished.length, 0, 'the event finish stopped a hand-started recording');
    // And out of the event entirely.
    clock.t += 1000;
    r.onSelf(makeSelfPayload({...base, t: 22, stateTime: 22, eventSubgroupId: undefined,
                              distance: 99999, eventDistance: undefined, remainingType: 'route'}));
    assertEq(finished.length, 0, 'leaving the event stopped a hand-started recording');
    r.stopManual();
    assertEq(finished[0].stopReason, 'manual');
});

check('auto recording off means no recording starts by itself', () => {
    const {finished} = recordSynthetic({autoRecord: false});
    assertEq(finished.length, 0);
});

check('a race ridden to the line stops at the line and describes the last kilometre', () => {
    // Long enough that the rider actually covers the event's 19.24 km, so Sauce's end-distance
    // test is what stops the recording, exactly as it would in a real race.
    const {finished} = recordSynthetic({seconds: 2400});
    const rec = finished[0];
    assertEq(rec.stopReason, 'finish');
    assert(rec.elapsedSeconds < 2000, `it ran to ${rec.elapsedSeconds}s instead of the line`);
    const lastDist = rec.timeline.eventDistance[rec.timeline.eventDistance.length - 1];
    assert(SYNTHETIC_END_DISTANCE - lastDist < 60,
           `stopped ${SYNTHETIC_END_DISTANCE - lastDist} m short of the line`);
    assert(rec.finishPosition >= 1 && rec.finishPosition <= 30,
           `the position as the line went by was ${rec.finishPosition}`);
    assertEq(rec.finishParticipants, 46);
    const m = buildReport({...rec, event: makeEventInfo()}, {});
    const finish = m.sections.find(x => x.id === 'finish').lines.join(' ');
    assert(finish.includes('last kilometre'), `no last kilometre: ${finish}`);
    assert(m.sections[0].lines.join(' ').includes(`was ${rec.finishPosition} of 46`),
           'the finishing position is missing from the report');
});

check('the finish is also caught when the event slice resource is present', () => {
    const {finished} = recordSynthetic({withEventsResource: true});
    assertEq(finished.length, 1);
    assertEq(finished[0].stopReason, 'finish');
    assertEq(finished[0].eventSliceId, 77);
});

check('leaving the event stops an automatic recording', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x)});
    const base = {
        power: 250, hr: 160, cadence: 85, speed: 40, draft: 20, grade: 0, wBal: 18000,
        activePowerUp: null, endDistance: SYNTHETIC_END_DISTANCE,
    };
    for (let t = 1; t <= 60; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({...base, t, stateTime: t, eventSubgroupId: 999,
                                  distance: t * 11, eventDistance: t * 11}));
    }
    clock.t += 1000;
    r.onSelf(makeSelfPayload({...base, t: 61, stateTime: 61, eventSubgroupId: undefined,
                              distance: 700, eventDistance: undefined, remainingType: 'route'}));
    assertEq(finished.length, 1);
    assertEq(finished[0].stopReason, 'left-event');
    assertEq(finished[0].incomplete, true);
});

check('the feed going quiet ends the recording rather than leaving it open forever', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x),
                            lostFeedSeconds: 120});
    for (let t = 1; t <= 30; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({
            t, stateTime: t, eventSubgroupId: 999, power: 250, hr: 160, cadence: 85, speed: 40,
            draft: 20, distance: t * 11, eventDistance: t * 11, grade: 0, wBal: 18000,
            activePowerUp: null, endDistance: SYNTHETIC_END_DISTANCE,
        }));
    }
    clock.t += 200000;
    r.tick();
    assertEq(finished.length, 1);
    assertEq(finished[0].stopReason, 'lost-feed');
    assertEq(finished[0].incomplete, true);
});

check('an event with no end distance and no end time is detected, not left running silently', () => {
    // sg.endDistance undefined makes Sauce publish remaining as NaN with remainingType still
    // 'event' (src/stats.mjs:4310-4315). A naive `remaining < 0` never fires against NaN.
    assertEq(isPastEventEnd({remainingType: 'event', remaining: NaN}), false);
    assertEq(hasUnknownEventEnd({eventSubgroupId: 1, remainingType: 'event', remaining: NaN}), true);
    assertEq(hasUnknownEventEnd({eventSubgroupId: 1, remainingType: 'event', remaining: 500}), false);
    const {finished, recorder: r} = recordSynthetic({noEventEnd: true, seconds: 120});
    assertEq(finished.length, 0, 'it stopped when there was nothing to stop it');
    assertEq(r.state, 'recording');
    assert(r.rec.notes.some(x => x.includes('no end distance and no end time')),
           `the rider was not told: ${JSON.stringify(r.rec.notes)}`);
});

check('a window that opened after the gun says so instead of pretending otherwise', () => {
    const {finished} = recordSynthetic({startAtSecond: 640, seconds: 1500});
    const rec = finished[0];
    assertEq(rec.clock, 'race');
    assertEq(rec.startedAtRaceSecond, 640);
    assertEq(rec.timeline.t[0], 640);
    assertEq(rec.incomplete, true);
    assert(rec.incompleteReasons.some(x => x.includes('after the gun')),
           `reasons were ${JSON.stringify(rec.incompleteReasons)}`);
    const m = buildReport({...rec, event: makeEventInfo()}, {});
    const text = JSON.stringify(m);
    assert(text.includes('not watching for the first'),
           'the start section does not say it missed the start');
    assert(!/You were recorded for \d+s/.test(text), 'it still claims a length it did not cover');
});

check('a window that opened after the gun still lines up with Sauce\'s own streams', () => {
    // This is the bug that produced "recorded for 20s" over forty minutes of power: the mod's
    // rows counted from the window, Sauce's streams counted from the gun.
    const {finished} = recordSynthetic({startAtSecond: 1400, seconds: 1500});
    const rec = {...finished[0], streams: makeStreams(1500)};
    const own = ownSeries(rec);
    assertEq(own.source, 'sauce-streams');
    assertEq(own.t[0], 0);
    assertEq(own.t[own.t.length - 1], 1499);
    // The grade series is resampled off the mod's own rows, which only exist from 1400 on.
    assertEq(own.grade[0], null, 'grade was invented for seconds the mod never saw');
    assert(own.grade[1450] != null, 'grade is missing for seconds the mod did record');
    const m = buildReport({...rec, event: makeEventInfo()}, {});
    const head = m.sections[0].lines.join(' ');
    // Sauce's own record covers the whole race, so the rider's own numbers do too, but the window
    // only watched the last hundred seconds and the report has to say both.
    assert(head.includes('0:00 to 24:59'), `the covered window is wrong: ${head}`);
    assert(head.includes('only started watching at 23:20'),
           `the report does not say when the window came up: ${head}`);
    const start = m.sections.find(x => x.id === 'start').lines.join(' ');
    assert(start.includes('not watching for the first'),
           `the start section does not say the pack story is missing: ${start}`);
});

check('a frozen window produces a recording that says how many seconds it missed', () => {
    // Chromium can stall a hidden renderer. The payloads then arrive in a burst and most of the
    // seconds are simply not there. The recording must not read as complete.
    const {finished} = recordSynthetic({dropEveryNth: 60, seconds: 1200});
    const rec = finished[0];
    assert(rec.coverage.rowsRecorded < 30, `it kept ${rec.coverage.rowsRecorded} rows`);
    assert(rec.coverage.missingSeconds > 1100, `missing was ${rec.coverage.missingSeconds}`);
    assert(rec.coverage.largestGapSeconds >= 60, 'the gaps were not measured');
    assertEq(rec.incomplete, true);
    const m = buildReport({...rec, event: makeEventInfo()}, {});
    assert(m.notes.join(' ').includes('are missing'),
           `the report does not mention the missing seconds: ${m.notes.join(' | ')}`);
});

check('Sauce having nobody in view is recorded differently from the feed dying', () => {
    const {finished} = recordSynthetic({emptyGroupsFrom: 400, emptyGroupsTo: 500, seconds: 900});
    const rec = finished[0];
    const blind = rec.pack.groupsVisible.filter(x => x === 0).length;
    assert(blind >= 45 && blind <= 55, `${blind} blind rows for 100 seconds at one row per two`);
    const i = packIndexNear(rec.pack, 450);
    assertEq(rec.pack.groupsVisible[i], 0);
    assertEq(rec.pack.myGroupSize[i], null);
    const m = buildReport({...rec, event: makeEventInfo()}, {});
    const sat = m.sections.find(x => x.id === 'position').lines.join(' ');
    assert(sat.includes('no rider in view at all'), `the two cases are not told apart: ${sat}`);
});

check('a payload another window has filtered is reported, not silently recorded as nothing', () => {
    // Sauce's per-listener mask walks the payload as an array, so a masked athlete listener gets
    // an array where an object should be (src/stats.mjs:806-823). The recorder must notice.
    const r = new Recorder({now: () => 1});
    assertEq(r.onSelf([undefined]), 'bad');
    assertEq(r.onSelf(null), 'bad');
    assertEq(r.onSelf({}), 'bad');
    assertEq(r.consecutiveBadSelfPayloads, 3);
    assertEq(r.onSelf(makeSelfPayload({
        t: 1, stateTime: 0, eventSubgroupId: undefined, power: 0, hr: 0, cadence: 0, speed: 0,
        draft: 0, distance: 0, eventDistance: undefined, grade: 0, wBal: 20000,
        activePowerUp: null, endDistance: undefined, remainingType: 'route',
    })), 'ok');
    assertEq(r.consecutiveBadSelfPayloads, 0);
});

check('Sauce being told to watch another rider is recorded as a caveat, not hidden', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x)});
    for (let t = 1; t <= 20; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({
            t, stateTime: t, eventSubgroupId: 999, watching: t < 10, power: 250, hr: 160,
            cadence: 85, speed: 40, draft: 20, distance: t * 11, eventDistance: t * 11, grade: 0,
            wBal: 18000, activePowerUp: null, endDistance: SYNTHETIC_END_DISTANCE,
        }));
    }
    r.stopManual();
    assertEq(finished[0].watchingSelfThroughout, false);
});

check('a long race degrades in steps instead of growing without limit', () => {
    const {finished} = recordSynthetic({seconds: 5400, sizeBudgetBytes: 120000});
    const rec = finished[0];
    assertEq(rec.degraded.packRowInterval, 5, 'the pack rows never thinned out');
    assertEq(rec.degraded.selfRowInterval, 5, 'the rider\'s own rows never thinned out');
    assert(rec.notes.some(x => x.includes('every five')), 'the report was not told');
    assert(JSON.stringify(rec).length < 1_000_000, 'recording grew past 1 MB');
});

check('the event tags that make Sauce record nothing are recognised', () => {
    assertEq(eventBlocksRecording(['hidethehud']), true);
    assertEq(eventBlocksRecording(['fenced', 'NOOVERLAYS']), true);
    assertEq(eventBlocksRecording(['powerup_percent=FEATHER:50']), false);
    assertEq(eventBlocksRecording('ranked;hidethehud'), true);
    assertEq(eventBlocksRecording(null), false);
});

check('the gun signal is Sauce\'s own, not merely being in an event', () => {
    assertEq(isPastEventEnd({remainingType: 'event', remaining: -1}), true);
    assertEq(isPastEventEnd({remainingType: 'event', remaining: 0}), false);
    assertEq(isPastEventEnd({remainingType: 'route', remaining: -50}), false);
    assertEq(activeEventSlice({eventSubgroupId: 5}), undefined);
    assertEq(activeEventSlice({eventSubgroupId: 5, events: []}), null);
    assertEq(activeEventSlice({eventSubgroupId: 5,
                               events: [{active: true, eventSubgroupId: 5, id: 9}]}).id, 9);
    assertEq(isSelfPayload({athleteId: 1}), true);
    assertEq(isSelfPayload([undefined]), false);
});

check('"only keep races" is off by default, because community races are often listed otherwise', () => {
    assertEq(DEFAULT_SETTINGS.racesOnly, false);
    assertEq(isRaceLike({eventType: 'RACE'}), true);
    assertEq(isRaceLike({eventType: 'TIME_TRIAL'}), true);
    assertEq(isRaceLike({eventType: 'GROUP_RIDE'}), false);
    assertEq(isRaceLike(null), false);
});

check('rider names in the copied text are on by default (Van, 16 Sep 2026)', () => {
    assertEq(DEFAULT_SETTINGS.namesInCopy, true);
});

check('the labels for riders Sauce cannot name run A, B, ... Z, AA', () => {
    assertEq(Roster.labelFor(0), 'Rider A');
    assertEq(Roster.labelFor(25), 'Rider Z');
    assertEq(Roster.labelFor(26), 'Rider AA');
    const a = new Roster();
    const b = new Roster();
    a.see(999, 0);
    b.see(111, 0);
    // Two recordings both start at "Rider A" for a different rider: labels do not carry over.
    assertEq(a.toJSON()['Rider A'].athleteId, null);
    assertEq(b.toJSON()['Rider A'].athleteId, null);
});

check('a rider named half way through does not leave a hole in the labels', () => {
    // Labels are worked out at save time, so a report can never show a "Rider B" with no
    // "Rider A" anywhere in it.
    const r = new Roster();
    r.see(1, 0);
    r.see(2, 5);
    r.see(3, 10);
    r.setName(1, 'Early Bird');   // arrives after the label would have been handed out
    const out = r.toJSON();
    assert(out['Rider A'], 'no Rider A');
    assert(out['Rider B'], 'no Rider B');
    assert(!out['Rider C'], 'a label was burned by the rider who got a name');
    assertEq(out['Rider A'].firstT, 5);
    assertEq(out['1'].name, 'Early Bird');
});

check('coverage maths holds up on the edge cases', () => {
    assertEq(computeCoverage({timeline: {t: []}}).rowsRecorded, 0);
    assertEq(computeCoverage({timeline: {t: [7]}}).spanSeconds, 1);
    const c = computeCoverage({timeline: {t: [0, 1, 2, 100, 101]}});
    assertEq(c.spanSeconds, 102);
    assertEq(c.rowsRecorded, 5);
    assertEq(c.missingSeconds, 97);
    assertEq(c.gaps.length, 1);
    assertEq(c.largestGapSeconds, 98);
});


/* ================================================================= 4. what gets stored */

section('4. what is stored stays inside what Sauce itself stores');

check('a rider Sauce could not name is stored with no athlete id at all', () => {
    for (const [key, r] of Object.entries(RACE.riders)) {
        if (!r.name) {
            assertEq(r.athleteId, null, `${key} carries an athlete id`);
            assert(key.startsWith('Rider '), `${key} is not a label`);
        }
    }
    const ids = Object.values(RACE.riders).map(x => x.athleteId).filter(x => x != null);
    assert(!ids.includes(5005), 'the id of the rider Sauce could not name is in the recording');
    assert(!Object.keys(RACE.riders).includes('5005'), 'that rider is keyed by their id');
    assertEq(Object.keys(RACE.riders).filter(k => k.startsWith('Rider ')).length, 1);
});

check('a named rider is stored with the id and the name Sauce already stores, and nothing else', () => {
    // Sauce keeps a full profile row per rider in athletes.sqlite (src/stats.mjs:3570-3577,
    // 2214-2246) and shows the name by default in its own Nearby window (pages/src/nearby.mjs:
    // 208-215). The mod keeps strictly less: id, name, the team tag Sauce reads out of that name
    // and shows in its Groups window (Van, 16 Sep 2026), a per-race sequence number, and when they
    // were in the rider's group.
    const allowed = new Set(['athleteId', 'label', 'name', 'team', 'seq', 'firstT', 'lastT', 'withMe']);
    for (const [key, r] of Object.entries(RACE.riders)) {
        for (const k of Object.keys(r)) {
            assert(allowed.has(k), `rider ${key} carries an unexpected field: ${k}`);
        }
    }
});

check('no second by second track of anybody else is kept', () => {
    // An earlier version sampled every rider's gap every five seconds and no line of the report
    // ever read it.
    for (const [key, r] of Object.entries(RACE.riders)) {
        assert(r.gaps === undefined, `rider ${key} still carries a gap track`);
    }
});

check('nothing about another rider that Sauce hides or that the report does not use', () => {
    const json = JSON.stringify(RACE);
    for (const banned of ['avatar', 'countryCode', 'racingScore', 'racingCategory', 'maxHeartRate',
                          'powerSourceModel', 'sanitizedName', 'firstName', 'lastName',
                          'gender', 'height', 'follower', 'following', 'favorite', 'latlng',
                          'profileData']) {
            assert(!json.includes(`"${banned}"`), `the recording carries ${banned}`);
    }
});

check('weight and FTP are stored for the rider alone, never for anybody else', () => {
    const json = JSON.stringify(RACE.riders);
    assert(!json.includes('ftp'), 'another rider\'s FTP is stored');
    assert(!json.includes('weight'), 'another rider\'s weight is stored');
});

// A store over the localStorage fallback, on a Storage in memory.
function localStore(storage = new MemoryStorage(), settings = new MemoryAdapter()) {
    return new Store(new LocalStorageKV(storage), settings, LOCAL_BUDGETS);
}

await checkAsync('recordings are saved, listed, opened and deleted', async () => {
    for (const store of [await openStore({indexedDB: new FakeIndexedDB()}), localStore()]) {
        const res = await store.save(RACE);
        assert(res.ok, res.error);
        assertEq(store.list().length, 1);
        assert(store.list()[0].bytes > 1000);
        const back = await store.load(RACE.id);
        assertEq(back.id, RACE.id);
        await store.remove(RACE.id);
        assertEq(store.list().length, 0);
        assertEq(await store.load(RACE.id), null);
    }
});

await checkAsync('deleting every recording leaves nothing behind', async () => {
    const storage = new MemoryStorage();
    const idb = new FakeIndexedDB();
    for (const store of [localStore(storage), await openStore({indexedDB: idb})]) {
        await store.save(RACE);
        await store.save({...RACE, id: 'rec-2'});
        await store.saveLive({...RACE, inProgress: true});
        await store.removeAll();
        assertEq(store.list().length, 0);
        assertEq(await store.loadLive(), null);
        assertEq(await store.loadPending(), null);
    }
    const leftovers = [...storage.map.keys(), ...idb.dump(DB_NAME).keys()]
        .filter(k => k.includes('race/') || k.includes('snap/') || k.endsWith('live') ||
                     k.endsWith('pending'));
    assertEq(leftovers.length, 0, `leftover keys: ${leftovers.join(', ')}`);
});

await checkAsync('a full storage pool is reported to the rider, with the recording still downloadable', async () => {
    const storage = new MemoryStorage();
    storage.limit = 2000;
    for (const store of [localStore(storage),
                         await openStore({indexedDB: new FakeIndexedDB({limit: 2000})})]) {
        const res = await store.save(RACE);
        assertEq(res.ok, false);
        assert(res.error.includes('Download this race to a file'), res.error);
        assert(res.json && res.json.length > 1000, 'no JSON to offer as a download');
        assertEq(store.list().length, 0, 'a failed save left an entry in the list');
    }
    assertEq(storage.map.size, 0, 'a failed save left pieces of the race in localStorage');
});

await checkAsync('the storage budget is small enough not to threaten Sauce\'s own settings', async () => {
    // Every Sauce window and every mod share one localStorage origin, commonly capped around
    // 5 MB, and Sauce handles QuotaExceededError nowhere. That rule is for the fallback only.
    const store = await openStore({indexedDB: null, localStorage: new MemoryStorage()});
    assertEq(store.kind, 'localstorage');
    assert(store.totalBudget <= 1_000_000, `total budget is ${store.totalBudget}`);
    assert(store.perRaceBudget <= 400_000, `per race budget is ${store.perRaceBudget}`);
    assert(store.warnAt < store.totalBudget, 'the warning comes after the cap');
});

await checkAsync('nothing is written under a "/" key, the settings included, and nothing carries a window id', async () => {
    // Sauce's windows JSON.parse the whole new value of any key starting with "/", and the
    // Watching window reloads for it (pages/src/common.mjs:66-84, pages/src/watching.mjs:1473-1486),
    // so nothing is kept under keys that do. Everything is written to localStorage directly,
    // because Common.storage would prefix it with the window id (pages/src/common.mjs:90, :103,
    // :122), which is minted fresh each time the window is added.
    const storage = spyStorage();
    const store = new Store(new LocalStorageKV(storage), new LocalSettings(storage), LOCAL_BUDGETS);
    await store.save(RACE);
    store.setSetting('racesOnly', false);
    await store.saveLive({...RACE, inProgress: true});
    for (const k of storage.map.keys()) {
        assert(k.startsWith(LOCAL_PREFIX), `key is not namespaced: ${k}`);
        assert(!k.startsWith('/'), `something is under a key Sauce parses: ${k}`);
    }
    assert(storage.map.has(KEY_SETTINGS), 'the settings were not written');
    assert(!KEY_SETTINGS.startsWith('/'), 'the settings key is one Sauce parses');
});

await checkAsync('the settings an earlier version kept under "/" are read, and that key is never written or removed', async () => {
    const storage = spyStorage();
    storage.setItem(LEGACY_KEY_SETTINGS, JSON.stringify({racesOnly: true, afterLineSeconds: 60}));
    storage.writes = [];
    let removed = 0;
    storage.removeItem = k => {
        removed++;
        MemoryStorage.prototype.removeItem.call(storage, k);
    };
    const store = await openStore({indexedDB: new FakeIndexedDB(), localStorage: storage,
                                   settings: new LocalSettings(storage),
                                   legacy: new LegacyStorage(storage)});
    assertEq(store.settings().racesOnly, true);
    assertEq(store.settings().afterLineSeconds, 60);
    assertEq(store.settings().autoRecord, DEFAULT_SETTINGS.autoRecord);
    assertEq(storage.writes.length, 0, 'reading the settings wrote them');
    store.setSetting('afterLineSeconds', 30);
    assertEq(storage.writes.map(x => x[0]).join(), KEY_SETTINGS);
    assertEq(store.settings().afterLineSeconds, 30);
    assertEq(store.settings().racesOnly, true, 'the old settings were not carried over');
    await store.dropMovedCopies();
    assertEq(JSON.parse(storage.getItem(LEGACY_KEY_SETTINGS)).afterLineSeconds, 60, 'the old key was written');
    assertEq(removed, 0, 'a key was removed');
    // ui.mjs hands the store these settings, not Common.storage.
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(ui.includes('new LocalSettings(ls') && !ui.includes('Common.storage'),
           'ui.mjs still keeps the settings in Common.storage');
});

await checkAsync('an interrupted recording can be picked up after Sauce restarts', async () => {
    const clock = new FakeClock();
    const r = new Recorder({now: () => clock.now()});
    const idb = new FakeIndexedDB();
    const store = await openStore({indexedDB: idb});
    for (let t = 1; t <= 400; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({
            t, stateTime: t, eventSubgroupId: 999, power: 260, hr: 165, cadence: 88, speed: 42,
            draft: 40, distance: t * 11, eventDistance: t * 11, grade: 0.01, wBal: 17000,
            eventPosition: 12, eventParticipants: 46, activePowerUp: null,
            endDistance: SYNTHETIC_END_DISTANCE,
        }));
        r.onGroups(makeGroupsPayload({myGroup: {ids: [SELF_ID, 2001, 2002], power: 280, draft: 50,
                                                hr: 168, speed: 42, gap: 0, id: 1}}));
        if (t % 20 === 0) {
            store.saveLive(r.snapshotForCrash(), {rowsEpoch: r.rowsEpoch});
        }
    }
    await store.loadLive();
    // Sauce quits here. A new window comes up and reads the snapshot back.
    const live = await (await openStore({indexedDB: idb})).loadLive();
    assert(live && live.inProgress, 'no snapshot was written');
    assert(live.counts.selfRows >= 380, `snapshot held only ${live.counts.selfRows} seconds`);
    assert(Object.keys(live.riders).length === 2, 'the riders were lost from the snapshot');
    assert(live.coverage, 'the snapshot does not say how complete it is');
    const resumed = {...live, endedAt: live.snapshotAt, stopReason: 'window-closed',
                     incomplete: true, incompleteReasons: ['the window or Sauce closed'],
                     elapsedSeconds: 390};
    delete resumed.inProgress;
    const model = buildReport(resumed, {});
    assert(model.sections.length > 3, 'no report could be made from the resumed recording');
});

await checkAsync('the interrupted recording is moved aside so a new one cannot overwrite it', async () => {
    // Sauce restarting mid race leaves two half recordings. Without this they fight over one key
    // and the rider loses whichever the banner did not win.
    const store = await openStore({indexedDB: new FakeIndexedDB()});
    await store.saveLive({id: 'rec-first-half', inProgress: true, startedISO: '2026-09-16T10:00:00Z',
                          counts: {selfRows: 300}});
    const pending = await store.takePending();
    assertEq(pending.id, 'rec-first-half');
    assertEq(await store.loadLive(), null, 'the live slot was not freed for the new recording');
    // The race is still running, so a second recording starts writing immediately.
    await store.saveLive({id: 'rec-second-half', inProgress: true, counts: {selfRows: 20}});
    assertEq((await store.loadPending()).id, 'rec-first-half', 'the first half was clobbered');
    assertEq((await store.loadLive()).id, 'rec-second-half');
});

check('being hidden does not lose the race, because the feed is what drives recording', () => {
    // The mod never depends on a timer to record: every row is written inside the subscription
    // callback, and the subscriptions are created with {persistent: true} so Sauce does not
    // suspend them when the window is hidden (src/main.mjs:223-230, :302). This test asserts the
    // recorder itself needs no ticks: it runs a whole race calling tick() zero times.
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x)});
    runSyntheticRace(r, clock);
    assertEq(finished.length, 1);
    assert(finished[0].counts.selfRows > 1400);
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    const subs = [...ui.matchAll(/Common\.subscribe\([\s\S]{0,400}?\}\);/g)].map(x => x[0]);
    assertEq(subs.length, 2, `expected 2 subscriptions, found ${subs.length}`);
    for (const s of subs) {
        assert(s.includes('persistent: true'), `a subscription is not persistent:\n${s}`);
    }
    const uiCode = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert(!/location\.href\s*=/.test(uiCode) && !/location\.reload\s*\(/.test(uiCode) &&
           !/location\.assign\s*\(/.test(uiCode),
           'the window navigates, which tears down every subscription (src/main.mjs:213)');
});

check('the groups feed asks Sauce for exactly what its own Groups window asks, and no rider profiles', () => {
    // ['state'] since 22 Sep 2026, for each rider's power and draft in the rider's group, exactly
    // as Sauce's own Groups window asks (pages/src/groups.mjs:824-830). Asking for 'athlete' would
    // make Sauce build and serialise every nearby rider's whole profile once a second (src/stats.mjs:783).
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    const m = ui.match(/Common\.subscribe\('groups\/v2'[\s\S]{0,300}?\}\);/);
    assert(m, 'no groups subscription found');
    assert(m[0].includes('resources: GROUPS_RESOURCES') && ui.includes("const GROUPS_RESOURCES = ['state'];"),
           `groups asks for resources: ${m[0]}`);
    const self = ui.match(/Common\.subscribe\('athlete\/self\/v2'[\s\S]{0,300}?\}\);/);
    assert(self[0].includes('SELF_RESOURCES'), 'the self subscription changed shape');
    assert(ui.includes("const SELF_RESOURCES = ['state']"),
           'the self subscription no longer matches Sauce\'s own Elevation window');
});


/* ================================================================= 5. the report */

section('5. the report and the fact pack');

const FULL = {
    ...RACE,
    event: makeEventInfo(),
    self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5},
    stats: makeEventSliceStatsV1({elapsedTime: 1501, activeTime: 1495, followTime: 1100,
                                  workTime: 300, soloTime: 101}),
    sauce: {version: '2.3.3'},
};

const model = buildReport(FULL, {});

check('the report has every section the race needs', () => {
    const ids = model.sections.map(x => x.id);
    for (const want of ['race', 'start', 'shape', 'position', 'draft', 'efforts', 'powerups',
                        'finish', 'who']) {
        assert(ids.includes(want), `missing section: ${want}`);
    }
});

check('the report names the event, the route and the rider\'s last live position', () => {
    const text = JSON.stringify(model);
    assert(text.includes('Ocean Lava Cliffside Loop'), 'the route is missing');
    assert(text.includes('19.24 km'), 'the distance is missing');
    assert(text.includes('156 m of climbing'), 'the climbing is missing');
});

check('a complete recording is not labelled incomplete and says nothing about holes', () => {
    assertEq(model.incomplete, false);
    assert(!model.notes.join(' ').includes('not a complete record'),
           'a complete race was described as incomplete');
});

check('the split shows up in the report with who left the group', () => {
    const shape = model.sections.find(x => x.id === 'shape');
    assert(shape.table, 'no split table');
    assert(shape.lines.join(' ').includes('Rider A'),
           'the rider Sauce could not name is missing from the report');
});

check('the draft split is described from Sauce\'s own follow, work and solo time', () => {
    const draft = model.sections.find(x => x.id === 'draft').lines.join(' ');
    assert(draft.includes('18m 20s'), `follow time missing: ${draft}`);
    assert(draft.includes('not the same as "on the front"'), 'the work-time caveat is missing');
});

check('"riders ahead" is worded so it cannot be read as "riders up the road"', () => {
    const sat = model.sections.find(x => x.id === 'position').lines.join(' ');
    assert(sat.includes('other groups up the road') || sat.includes('riders in other groups'),
           `the wording still invites the wrong reading: ${sat}`);
});

check('durations in the report are seconds, not counts of rows', () => {
    // Pack rows are one every two seconds. Printing a row count through fmtDuration would halve
    // every duration in "Where you sat" without anything looking wrong.
    const sat = model.sections.find(x => x.id === 'position').lines.join(' ');
    const m2 = sat.match(/For (\d+)m (\d+)s of the recording there was no group visible ahead of yours, and for (\d+)m (\d+)s there was/);
    assert(m2, `the sentence changed shape: ${sat}`);
    const total = (+m2[1] * 60 + +m2[2]) + (+m2[3] * 60 + +m2[4]);
    assert(Math.abs(total - model.meta.raceSeconds) <= 4,
           `the two durations add up to ${total}s for a ${model.meta.raceSeconds}s race`);
});

check('the report says what it cannot know instead of guessing', () => {
    assert(model.cannot.length >= 7);
    assert(model.cannot.join(' ').includes('Why anyone did anything'));
    assert(model.cannot.join(' ').includes('frame or wheels'));
});

check('the disclaimer does not claim opted-out riders can never reach a mod', () => {
    // v2.3.0 splices the wrong indexes when dropping them (src/zwift.mjs:2197-2201), so the plain
    // version of that sentence is false on the Sauce most people are running.
    const text = model.disclaimer.lines.join(' ');
    assert(!text.includes('removed from the data before any mod'),
           'the disclaimer still makes the claim that is false on v2.3.0');
    assert(text.includes('can still reach a mod'), `the disclaimer does not say what really happens: ${text}`);
    assert(text.includes('Use at your own risk'));
    assert(model.disclaimer.lines.length >= 5);
});

check('no training advice and no prescriptions anywhere in the report', () => {
    const text = (JSON.stringify(model) + renderReportHTML(model)).toLowerCase();
    for (const banned of ['you should', 'you need to', 'try to hold', 'next time, ', 'recommend',
                          'training plan', 'interval session', 'work on your', 'aim for']) {
        assert(!text.includes(banned), `the report gives advice: "${banned}"`);
    }
});

check('the report never claims to know why anyone did anything', () => {
    // The "what this cannot know" list names those words in order to rule them out, so the check
    // is against the report body only.
    const text = JSON.stringify(model.sections).toLowerCase();
    for (const banned of ['attacked', 'was chasing', 'sat on', 'decided to', 'in order to',
                          'because he', 'because she', 'because they']) {
        assert(!text.includes(banned), `the report claims intent: "${banned}"`);
    }
});

check('no source file citations are shown to the rider', () => {
    const html = renderReportHTML(model);
    assert(!/src\/[a-z]+\.mjs/.test(html), 'the report shows source file names');
    assert(!/:\d{3,4}\)/.test(html), 'the report shows source line numbers');
});

check('the report renders to HTML with everything escaped', () => {
    const nasty = {...FULL, event: {...FULL.event, name: '<img src=x onerror=alert(1)>'}};
    const html = renderReportHTML(buildReport(nasty, {}));
    assert(html.includes('&lt;img'), 'HTML was not escaped');
    assert(!html.includes('<img src=x'), 'raw HTML got through');
});

check('a recording with almost nothing in it still produces a report, saying so', () => {
    const thin = {id: 'rec-thin', startedISO: new Date().toISOString(), elapsedSeconds: 4,
                  clock: 'wall', timeline: {t: [0, 1], power: [200, 210]}, pack: {}, riders: {},
                  notes: [], counts: {}};
    const m = buildReport(thin, {});
    const text = JSON.stringify(m);
    assert(text.includes('not enough recorded') || text.includes('No group information'),
           'a thin recording did not say it was thin');
});

const factPack = buildFactPack(FULL, {model});

const debriefPack = buildFactPack(FULL, {model, style: 'debrief'});

check('each copied text carries its own prompt, the facts, and the limits', () => {
    for (const text of [factPack, debriefPack]) {
        for (const head of ['RACE', 'HOW COMPLETE THIS RECORD IS', 'HOW TO READ THESE FACTS', 'MINUTE BY MINUTE',
                            'KEY MOMENTS', 'CLIMBS', 'HOW THE GAPS MOVED', 'YOUR FINISH',
                            'POWERUPS ACTIVE ON YOU', 'WHAT IS NOT KNOWN']) {
            assert(text.includes(`=== ${head} ===`), `no ${head}`);
        }
    }
    assert(factPack.startsWith(PROMPTS.commentary), 'the commentary text does not open with its prompt');
    assert(debriefPack.startsWith(PROMPTS.debrief), 'the debrief text does not open with its prompt');
    assert(factPack.includes('=== WHO WAS WHERE, BETWEEN THE KEY MOMENTS ==='));
    assert(debriefPack.includes('=== YOUR BIGGEST EFFORTS AND WHAT THEY COST ==='));
    assert(debriefPack.includes('=== YOUR EARLIER RACES ==='));
    assert(!debriefPack.includes('=== AFTER THE LINE ==='), 'the debrief carries After the line');
    assert(debriefPack.includes('Do not give training advice'));
    assert(!factPack.includes('You are writing a race report for a Zwift race'), 'the old single prompt is still there');
    assert(factPack.includes('Ocean Lava Cliffside Loop'));
});

check('the fact pack includes rider names by default, and says so in the last line', () => {
    assert(factPack.includes('Racer 2001'), 'another rider was withheld from the default copy');
    assert(factPack.includes('Test Rider'), 'the rider was withheld from the default copy');
    assert(factPack.includes('including the rider names in it'),
           'the rider is not told what they are pasting');
    assert(!factPack.includes('deliberately left out'));
});

check('unticking the box withholds every rider name, including the rider\'s own', () => {
    const anon = buildFactPack(FULL, {model, includeNames: false});
    assert(!anon.includes('Racer 2001'), 'another rider was named after unticking');
    assert(!anon.includes('Test Rider'), 'the rider was named after unticking');
    assert(anon.includes('Rider A'), 'nobody is identifiable at all, even by label');
    assert(anon.includes('deliberately left out'), 'the AI is not told why there are no names');
});

check('the fact pack tells the AI how complete the record is', () => {
    assert(factPack.includes('Seconds recorded:'));
    assert(factPack.includes('no material gaps'));
    const holed = buildFactPack({...FULL, incomplete: true,
                                 incompleteReasons: ['600 of the 1500 seconds were not recorded']},
                                {});
    assert(holed.includes('NOT a complete record'), 'a holed recording was passed off as whole');
});

check('the fact pack fits in a chat box', () => {
    assert(factPack.length <= HARD_CAP_CHARACTERS, `fact pack is ${factPack.length} characters`);
    assert(factPack.length > 2000, `fact pack is only ${factPack.length} characters`);
});

check('the fact pack tells the rider what pasting it into an AI means', () => {
    assert(factPack.includes('sends it to that service'));
});

check('the fact pack shows no source file citations either', () => {
    assert(!/src\/[a-z]+\.mjs/.test(factPack), 'the fact pack shows source file names');
});

check('imperial units are honoured throughout', () => {
    const m = buildReport(FULL, {imperial: true});
    const text = JSON.stringify(m);
    assert(text.includes(' mi'), 'no miles');
    assert(!text.includes(' km'), 'kilometres leaked into an imperial report');
});

check('best-window maths picks the real peak', () => {
    const t = Array.from({length: 100}, (_, i) => i);
    const v = t.map(i => (i >= 40 && i < 45) ? 500 : 200);
    const best = bestWindow(t, v, 5);
    assert(best.avg > 450, `best 5 s was ${best.avg}`);
    assert(best.startT >= 39 && best.startT <= 41, `peak at ${best.startT}`);
});

check('summarize builds the row the recordings list shows, including why it is incomplete', () => {
    const s = summarize(FULL);
    assertEq(s.eventName, 'Ocean Lava Cliffside Loop Scratch Race');
    assertEq(s.subgroupLabel, 'B');
    assertEq(s.riders, 15);
    assertEq(s.incomplete, false);
    const bad = summarize({...FULL, incomplete: true, incompleteReasons: ['the feed stopped']});
    assertEq(bad.incompleteReasons[0], 'the feed stopped');
});

check('the minimum Sauce version is stated in one place and shown in the window', () => {
    assert(/^\d+\.\d+\.\d+$/.test(MIN_SAUCE_VERSION), 'no minimum version is declared');
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    assert(html.includes('id="min-sauce-version"'), 'the window does not show it');
    const readme = FS.readFileSync(Path.join(MOD_DIR, 'README.md'), 'utf8');
    assert(readme.includes(MIN_SAUCE_VERSION), 'the README does not state it');
});


/* ================================================================= 6. after the line */

section('6. after the line: watching the riders behind come in, with the race still ending at the line');

// One feed, run on for 125 seconds past the rider's finish, recorded with no extra time and with
// two minutes of it. Riders behind: the rider's own bunch a second or two back, a group of two
// that closes from 48 s to under 44 s, and a group of two 200 s back that never gets there.
const AFTER_FEED = {afterSeconds: 125};
const RACE_0 = recordSynthetic({...AFTER_FEED, afterLineSeconds: 0}).finished[0];
const RACE_120 = recordSynthetic({...AFTER_FEED, afterLineSeconds: 120}).finished[0];

const withExtras = (rec, streamSeconds) => ({
    ...rec,
    event: makeEventInfo(),
    self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5},
    stats: makeEventSliceStatsV1({elapsedTime: 1501, activeTime: 1495, followTime: 1100,
                                  workTime: 300, soloTime: 101}),
    streams: makeStreams(streamSeconds),
    sauce: {version: '2.3.3'},
});

// Everything a saved race says about the race itself, leaving out the extra time and the two
// wall clock stamps that are meant to differ.
const raceOnly = rec => {
    const copy = {...rec};
    delete copy.afterLine;
    delete copy.endedAt;
    delete copy.endedISO;
    return JSON.stringify(copy);
};

// The copied text apart from what the extra time adds: After the line, and in YOUR FINISH where the
// rider crossed within their group, which only the extra time can show.
const withoutAfterLine = text => text.replace(/\n\n=== AFTER THE LINE ===[\s\S]*?(?=\n\n===)/, '')
    .replace(/\n\n=== YOUR FINISH ===[\s\S]*?(?=\n\n===)/, '');

// The saved race, the report's race sections and the copied text with and without names, for two
// recordings of one race, which must match in every way apart from the extra time.
function assertRaceViewsEqual(a, b, what) {
    assertEq(raceOnly(a), raceOnly(b), `${what}: the saved race itself differs`);
    const ma = buildReport(a, {});
    const mb = buildReport(b, {});
    const race = m => JSON.stringify({
        sections: m.sections.filter(x => x.id !== 'afterline'),
        notes: m.notes, cannot: m.cannot, meta: m.meta, incomplete: m.incomplete,
    });
    assertEq(race(ma), race(mb), `${what}: the report differs`);
    for (const includeNames of [true, false]) {
        for (const style of ['commentary', 'debrief']) {
            const fa = buildFactPack(a, {model: ma, includeNames, style});
            const fb = buildFactPack(b, {model: mb, includeNames, style});
            if (b.afterLine && style === 'commentary') {
                assert(fb.includes('=== AFTER THE LINE ==='), `${what}: the copied text has no After the line section`);
            }
            assertEq(withoutAfterLine(fb), withoutAfterLine(fa),
                     `${what}: the copied ${style} differs (names ${includeNames})`);
        }
    }
}

// A short race finish on a millisecond clock (runLineFinish in synthetic-feed.mjs), recorded with
// the given extra time. Sauce's streams for the race are attached the way ui.mjs does.
function recordLine(afterLineSeconds, feed = {}, options = {}) {
    const clock = new FakeClock();
    const finished = [];
    const lines = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x),
                            onLine: x => lines.push(JSON.parse(JSON.stringify(x))),
                            afterLineSeconds, ...options});
    runLineFinish(r, clock, {...feed, onSecond: feed.onSecond && (s => feed.onSecond(s, r))});
    clock.t += 400_000;
    r.tick();
    const rec = finished[0];
    return {rec: rec && {...rec, streams: makeStreams(feed.race ?? 250)}, recorder: r, lines};
}

check('the setting is two minutes by default, and the recorder on its own adds nothing', () => {
    assertEq(DEFAULT_SETTINGS.afterLineSeconds, 120);
    assertEq(new Recorder({}).afterLineSeconds, 0);
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/afterLineSeconds: store\.settings\(\)\.afterLineSeconds/.test(ui),
           'ui.mjs does not hand the setting to the recorder');
    assert(ui.includes('recorder.afterLineSeconds = settings.afterLineSeconds'),
           'ui.mjs does not keep the recorder in step with the setting');
});

check('the setting is in the settings pane, in plain words', () => {
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    const m = html.match(/<label>Keep recording for[\s\S]*?<\/label>/);
    assert(m, 'no "Keep recording for" setting in the window');
    assert(m[0].includes('data-setting="afterLineSeconds"'), 'the control is not wired to the setting');
    assert(m[0].includes('<option value="120">2 minutes</option>'), 'two minutes is not a choice');
    assert(m[0].includes('<option value="0">'), 'there is no way to turn it off');
    assert(m[0].includes('to see the riders behind you come in'), 'the wording does not say what it is for');
    const values = [...m[0].matchAll(/value="(\d+)"/g)].map(x => +x[1]);
    assert(Math.max(...values) <= MAX_AFTER_LINE_SECONDS, `a choice goes past ${MAX_AFTER_LINE_SECONDS} s`);
});

check('the extra 120 seconds after the line are recorded and counted', () => {
    assert(RACE_120, 'no recording was produced');
    assertEq(RACE_120.stopReason, 'finish');
    const al = RACE_120.afterLine;
    assert(al, 'no afterLine block');
    assertEq(al.finishRaceSecond, 1501, 'the line is on the wrong second');
    assertEq(al.requestedSeconds, 120);
    assertEq(al.secondsCaptured, 120);
    assertEq(al.endedBy, 'time');
    assertEq(al.timeline.t[0], 1501);
    assertEq(al.timeline.t.length, 120);
    assert(al.pack.t.length >= 59 && al.pack.t.length <= 61, `${al.pack.t.length} pack rows after the line`);
    assertEq(RACE_120.timeline.t[RACE_120.timeline.t.length - 1], 1500,
             'the race timeline runs past the line');
    assertEq(RACE_120.pack.t[RACE_120.pack.t.length - 1] < 1501, true,
             'the race pack rows run past the line');
});

check('it keeps going past the line until the time is up, not a packet longer', () => {
    const early = recordSynthetic({afterSeconds: 60, afterLineSeconds: 120});
    assertEq(early.finished.length, 0, 'it stopped before the two minutes were up');
    assertEq(early.recorder.isAfterLine(), true);
    assertEq(early.recorder.afterLineSecondsLeft(), 60);
});

check('the riders who came in behind are found, with their gaps, and the ones ahead are not', () => {
    const al = RACE_120.afterLine;
    assertEq(al.ridersReportedFinish, true);
    assertEq(al.arrivals.length, 11, JSON.stringify(al.arrivals.map(x => x.rider)));
    const keys = al.arrivals.map(x => x.rider);
    for (const ahead of ['2001', '2002', '2003', 'Rider A']) {
        assert(!keys.includes(ahead), `${ahead} finished ahead of the rider and was counted as coming in`);
    }
    const chase = al.arrivals.find(x => x.rider === '3001');
    assertEq(chase.gap, 43.6);
    assertEq(chase.firstSeenGap, 48);
    assertEq(al.stillOnRoad, 2, 'the group that never reached the line is not counted as still out');
    // Everyone who came in was already one of the race's riders, and the group 200 s back never
    // came in, so nothing new about anybody is kept after the line.
    assert(RACE_120.riders['3001'], 'the chase group is not among the race\'s riders');
    assertEq(Object.keys(al.riders).length, 0);
    assert(!RACE_120.riders['3003'], 'a rider first seen after the line joined the race\'s riders');
});

check('race numbers are identical with 0 and with 120 extra seconds', () => {
    assertEq(raceOnly(RACE_0), raceOnly(RACE_120), 'the saved race itself differs');
    assertEq(RACE_0.afterLine, null);
    // Sauce's own streams, which the report prefers. Sauce's event slice closes on the same state
    // that trips the finish and never grows again (src/stats.mjs:3059-3062, :3372-3375), so both
    // recordings are handed the same arrays.
    const a = withExtras(RACE_0, 1500);
    const b = withExtras(RACE_120, 1500);
    assertEq(ownSeries(a).t.length, ownSeries(b).t.length, 'Sauce\'s streams were cut differently');
    assertRaceViewsEqual(a, b, 'the synthetic race');
});

check('setting 0 behaves exactly as before: it stops on the finish packet and adds nothing', () => {
    const {finished, recorder: r} = recordSynthetic({...AFTER_FEED, afterLineSeconds: 0});
    assertEq(finished.length, 1);
    assertEq(r.state, 'idle');
    // The same race recorded with no after-the-line feed at all, as every test above does.
    assertEq(JSON.stringify(finished[0]), JSON.stringify(RACE), 'setting 0 changed the recording');
    const m = buildReport(FULL, {});
    assert(!m.sections.some(x => x.id === 'afterline'), 'a race with no extra time has an After the line section');
    assert(!buildFactPack(FULL, {model: m}).includes('AFTER THE LINE'),
           'a race with no extra time has an After the line section in the copied text');
});

check('a recording started by hand is not affected by the setting', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x),
                            afterLineSeconds: 120});
    r.startManual();
    const base = {power: 250, hr: 160, cadence: 85, speed: 40, draft: 20, grade: 0, wBal: 18000,
                  activePowerUp: null, endDistance: SYNTHETIC_END_DISTANCE};
    for (let t = 1; t <= 20; t++) {
        clock.t += 1000;
        r.onSelf(makeSelfPayload({...base, t, stateTime: t, eventSubgroupId: 999,
                                  distance: t * 11, eventDistance: SYNTHETIC_END_DISTANCE + t}));
    }
    assertEq(r.isAfterLine(), false, 'a hand-started recording went into the extra time');
    r.stopManual();
    assertEq(finished[0].stopReason, 'manual');
    assertEq(finished[0].afterLine, null);
});

check('Stop during the extra time ends it at once, keeping everything so far', () => {
    const {finished, recorder: r} = recordSynthetic({afterSeconds: 30, afterLineSeconds: 120});
    assertEq(finished.length, 0);
    assertEq(r.stopManual(), true);
    assertEq(finished.length, 1);
    const rec = finished[0];
    assertEq(rec.stopReason, 'finish', 'Stop after the line turned a finished race into a manual one');
    assertEq(rec.afterLine.endedBy, 'stop');
    assertEq(rec.afterLine.secondsCaptured, 31);
    assertEq(rec.afterLine.arrivals.length, 9, 'the riders who came in before Stop were lost');
    assertEq(rec.incomplete, false, `incomplete because: ${rec.incompleteReasons.join('; ')}`);
    assertEq(raceOnly(rec), raceOnly(RACE_0), 'stopping early changed the race');
    const lines = buildReport(rec, {}).sections.find(x => x.id === 'afterline').lines.join(' ');
    assert(lines.includes('because you pressed Stop'), `the report does not say why it ended: ${lines}`);
});

check('leaving or changing the event during the extra time ends it at once', () => {
    const left = recordSynthetic({afterSeconds: 60, afterLineSeconds: 120, leaveEventAt: 20}).finished;
    assertEq(left.length, 1);
    assertEq(left[0].stopReason, 'finish');
    assertEq(left[0].afterLine.endedBy, 'left-event');
    assertEq(left[0].afterLine.secondsCaptured, 20);
    assertEq(left[0].incomplete, false);
    assertEq(raceOnly(left[0]), raceOnly(RACE_0), 'leaving after the line changed the race');
    // Zwift can drop the rider from the event by itself after a finish, so it is not "you left".
    const leftText = buildReport(left[0], {}).sections.find(x => x.id === 'afterline').lines.join(' ');
    assert(leftText.includes('because Sauce stopped showing you in the event'), leftText);
    assert(!leftText.includes('you left the event'), leftText);

    const {finished, recorder: r, clock} = recordSynthetic({afterSeconds: 10, afterLineSeconds: 120});
    clock.t += 1000;
    r.onSelf(makeSelfPayload({
        t: 1512, stateTime: 1512, eventSubgroupId: 1000, power: 90, hr: 140, cadence: 60, speed: 18,
        distance: 17600, eventDistance: 100, grade: 0, wBal: 15000, activePowerUp: null,
        endDistance: SYNTHETIC_END_DISTANCE,
    }));
    assertEq(finished.length, 1);
    assertEq(finished[0].stopReason, 'finish');
    assertEq(finished[0].afterLine.endedBy, 'changed-event');
    assertEq(finished[0].incomplete, false);
});

check('the extra time never makes a recording incomplete, however it ends', () => {
    assertEq(RACE_120.incomplete, false, `incomplete because: ${RACE_120.incompleteReasons.join('; ')}`);
    assertEq(JSON.stringify(RACE_120.coverage), JSON.stringify(RACE_0.coverage),
             'the extra time was counted into the race\'s coverage');
    // The feed going quiet after the line.
    const quiet = recordSynthetic({afterSeconds: 10, afterLineSeconds: 120});
    quiet.clock.t += 200000;
    quiet.recorder.tick();
    assertEq(quiet.finished.length, 1);
    assertEq(quiet.finished[0].stopReason, 'finish');
    assertEq(quiet.finished[0].incomplete, false);
    // Sauce closing during the extra time: the snapshot is already cut at the line.
    const open = recordSynthetic({afterSeconds: 40, afterLineSeconds: 120});
    const snap = open.recorder.snapshotForCrash();
    assertEq(snap.timeline.t[snap.timeline.t.length - 1], 1500, 'the snapshot runs past the line');
    assertEq(snap.afterLine.endedBy, 'window-closed');
    assertEq(snap.elapsedSeconds, RACE_0.elapsedSeconds);
    const resumed = {...snap, stopReason: 'finish'};
    delete resumed.inProgress;
    applyIncompleteness(resumed);
    assertEq(resumed.incomplete, false, `incomplete because: ${resumed.incompleteReasons.join('; ')}`);
});

const AFTER_MODEL = buildReport(withExtras(RACE_120, 1500), {});
const AFTER_SECTION = AFTER_MODEL.sections.find(x => x.id === 'afterline');

check('the report has an After the line section, after the race and apart from it', () => {
    assert(AFTER_SECTION, 'no After the line section');
    assertEq(AFTER_SECTION.title, 'After the line');
    const ids = AFTER_MODEL.sections.map(x => x.id);
    assert(ids.indexOf('afterline') > ids.indexOf('who'), 'After the line sits inside the race sections');
    const text = AFTER_SECTION.lines.join(' ');
    assert(text.includes('after you crossed the line at 25:01'), `the line is not named: ${text}`);
    assert(text.includes('those all stop at the line'), 'it does not say the race numbers stop at the line');
    assert(text.includes('Exact finish times and places come from the official results, not from this part'),
           'it does not say where finish times and places really come from');
    assert(text.includes('11 riders reached the line behind you'), `the count is wrong: ${text}`);
    assert(text.includes('A group of 9 came in between 0.2 and 1.8 seconds behind you'),
           `the rider's own bunch is not described: ${text}`);
    assert(text.includes('48.0 seconds behind you') && text.includes('4.4 seconds closer'),
           `the group that closed a gap is not described: ${text}`);
    assert(text.includes('2 riders Sauce had in view behind you had not reached the line'),
           `the riders still out are not mentioned: ${text}`);
    assertEq(AFTER_SECTION.table.rows.length, 11);
    assertEq(AFTER_SECTION.table.rows[9][0], 'Racer 3001');
    assertEq(AFTER_SECTION.table.rows[9][2], '43.6 s');
    const html = renderReportHTML(AFTER_MODEL);
    assert(html.includes('<section id="sec-afterline"><h2>After the line</h2>'), 'it is not rendered');
});

check('the copied text has its own After the line section, names withheld when asked', () => {
    const text = buildFactPack(withExtras(RACE_120, 1500), {model: AFTER_MODEL});
    const m = text.match(/=== AFTER THE LINE ===[\s\S]*?(?=\n\n===)/);
    assert(m, 'no After the line section in the copied text');
    const part = m[0];
    assert(part.includes('nothing above includes this time'), part);
    assert(part.includes('Exact finish times and places come from the official results'), part);
    assert(part.includes('Riders who reached the line behind the rider in this time: 11'), part);
    assert(part.includes('A group of 2 came in 43.6 to 43.8 s behind, at 25:45: Racer 3001, Racer 3002'), part);
    assert(part.includes('4.4 s closer'), part);
    const anon = buildFactPack(withExtras(RACE_120, 1500), {model: AFTER_MODEL, includeNames: false});
    const anonPart = anon.match(/=== AFTER THE LINE ===[\s\S]*?(?=\n\n===)/)[0];
    assert(!/Racer \d+/.test(anonPart), `a name leaked into the withheld copy: ${anonPart}`);
    assert(!anonPart.includes('an unrecorded rider'), `a rider first seen after the line has no label: ${anonPart}`);
});

check('when nobody came into view after the line, both say so and invent nobody', () => {
    const rec = recordSynthetic({...AFTER_FEED, afterLineSeconds: 120, afterRiders: false}).finished[0];
    assertEq(rec.afterLine.arrivals.length, 0);
    assertEq(rec.afterLine.ridersSeenBehind, 0);
    const m = buildReport(rec, {});
    const sec = m.sections.find(x => x.id === 'afterline');
    assert(sec, 'no After the line section');
    const text = sec.lines.join(' ');
    assert(text.toLowerCase().includes('nobody came into view'), `it does not say so: ${text}`);
    assert(!/reached the line behind you|came in (between|\d)/.test(text),
           `it describes arrivals that did not happen: ${text}`);
    assertEq(sec.table, null);
    const fp = buildFactPack(rec, {model: m});
    const part = fp.match(/=== AFTER THE LINE ===[\s\S]*?(?=\n\n===)/)[0];
    assert(part.toLowerCase().includes('nobody came into view'), `the copied text does not say so: ${part}`);
    assert(!part.includes('came in at'), part);
});

check('the After the line wording gives no advice and claims no intent', () => {
    const text = JSON.stringify(AFTER_SECTION).toLowerCase();
    for (const banned of ['you should', 'you need to', 'recommend', 'aim for', 'attacked',
                          'was chasing', 'sat on', 'decided to', 'in order to', 'because they']) {
        assert(!text.includes(banned), `the After the line part says "${banned}"`);
    }
    for (const f of ['race-report.html', 'src/report.mjs', 'src/factpack.mjs']) {
        const s = FS.readFileSync(Path.join(MOD_DIR, f), 'utf8');
        assert(!s.includes('\u2014'), `${f} contains an em-dash`);
    }
});

// Riders for the millisecond-clock finishes below: the rider's own bunch a fraction of a second
// back, and a chase group twenty seconds back that comes in inside the extra time.
const LINE_RIDERS = [
    {id: 2001, gap: 0.3, group: 0, name: 'always'},
    {id: 2002, gap: 0.8, group: 0, name: 'always'},
    {id: 3001, gap: 20, group: 1, name: 'always'},
    {id: 3002, gap: 20.4, group: 1, name: 'always'},
];

check('the race is cut at the finish packet, not at a second, whatever order the packets arrive in', () => {
    const timings = {
        'self first, then groups': {selfPhase: 100, groupsPhase: 300},
        'groups first, then self': {selfPhase: 600, groupsPhase: 100},
        'the finish packet 300 ms after the last race packet': {selfPhase: 200, groupsPhase: 900,
                                                                finishLateMs: -700},
        'the finish packet 800 ms late, after that second\'s groups row': {selfPhase: 100,
                                                                           groupsPhase: 600,
                                                                           finishLateMs: 800},
        'the gun packet 5 ms late': {selfPhase: 996, groupsPhase: 400, gunLateMs: 5},
    };
    for (const [what, timing] of Object.entries(timings)) {
        const feed = {...timing, riders: LINE_RIDERS};
        const zero = recordLine(0, feed).rec;
        const extra = recordLine(120, feed).rec;
        assert(zero && extra, `${what}: no recording`);
        assert(extra.afterLine && extra.afterLine.secondsCaptured >= 118,
               `${what}: the extra time was not recorded`);
        assertRaceViewsEqual(zero, extra, what);
    }
});

check('the race handed over at the line is exactly the race a recording with no extra time saves', () => {
    const lines = [];
    const r120 = recordSynthetic({...AFTER_FEED, afterLineSeconds: 120,
                                  onLine: x => lines.push(JSON.stringify(x))});
    assertEq(lines.length, 1, 'onLine was not called once at the line');
    assertEq(lines[0], JSON.stringify(RACE_0), 'the race saved at the line differs from the race with no extra time');
    // What ui.mjs saves at the end of the extra time: the race saved at the line plus afterLine.
    const atLine = JSON.parse(lines[0]);
    assertEq(JSON.stringify(withAfterLine(atLine, r120.finished[0])), JSON.stringify(r120.finished[0]));
    // Settings 0 never calls it.
    const zero = [];
    recordSynthetic({...AFTER_FEED, afterLineSeconds: 0, onLine: x => zero.push(x)});
    assertEq(zero.length, 0);
    // A snapshot during the extra time holds the race's own counts, not the rows past the line.
    const open = recordSynthetic({afterSeconds: 40, afterLineSeconds: 120});
    const snap = open.recorder.snapshotForCrash();
    assertEq(JSON.stringify(snap.counts), JSON.stringify(RACE_0.counts));
    assertEq(JSON.stringify(snap.riders), JSON.stringify(RACE_0.riders));
    // ui.mjs saves the race at the line and adds only the extra time at the end, also on resume.
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/new Recorder\(\{onLine, onFinalized/.test(ui), 'ui.mjs does not listen for the line');
    assert(/savedAtLine\.set\(race\.id, saveFinishedRace\(race/.test(ui), 'ui.mjs does not save the race at the line');
    assert(/withAfterLine\(await store\.load\(rec\.id\) \|\| done\.rec, rec\)/.test(ui),
           'ui.mjs does not add the extra time to the race saved at the line');
    assert(/rec = withAfterLine\(savedRace, rec\)/.test(ui),
           'resuming after a close in the extra time does not use the race saved at the line');
});

check('names that arrive during the extra time do not change the race', () => {
    const feed = {
        nameLookupEvery: 20,
        riders: [
            ...LINE_RIDERS,
            {id: 5005, gap: 0.5, group: 0, name: 'never'},
            {id: 5006, gap: 0.6, group: 0, name: 'afterLine'},
            // Joins the rider's group in the last fifteen seconds, and Sauce only finds a profile
            // for them after the line.
            {id: 2099, gap: 0.9, group: 0, hidden: [1, 235], name: 'afterLine'},
            {id: 3003, gap: 30, group: 2, hidden: [1, 252], name: 'afterLine'},
            // In view behind all race long with no name, then named after the line, then comes in.
            {id: 3004, gap: 40, group: 3, name: 'afterLine'},
        ],
    };
    const zero = recordLine(0, feed).rec;
    const extra = recordLine(120, feed).rec;
    assertEq(zero.counts.anonymousRiders, 4);
    assertEq(extra.counts.anonymousRiders, 4, 'a name that arrived after the line changed the unnamed count');
    assertRaceViewsEqual(zero, extra, 'late names');
    // A rider first seen after the line can still be named.
    const came = extra.afterLine.arrivals.find(x => x.rider === '3003');
    assert(came, `the rider who came in 30 s back is not named: ${JSON.stringify(extra.afterLine.arrivals)}`);
    // A race rider who comes in is saved under the same key the race knows them by.
    for (const x of extra.afterLine.arrivals) {
        assert(extra.riders[x.rider] || extra.afterLine.riders[x.rider],
               `came in as ${x.rider}, which the recording does not know`);
    }
    assert(extra.afterLine.arrivals.some(x => /^Rider [A-Z]$/.test(x.rider)),
           `the unnamed race rider who came in is not under their race label: ${JSON.stringify(extra.afterLine.arrivals)}`);
});

check('a note added during the extra time stays out of the race', () => {
    const NOTE = 'The live data feed was not usable, so this recording was read once a second.';
    const feed = {riders: LINE_RIDERS, onSecond: (s, r) => (s === 262 ? r.addNote(NOTE) : null)};
    const zero = recordLine(0, feed).rec;
    const extra = recordLine(120, feed).rec;
    assertEq(extra.notes.length, 0, 'the note landed in the race');
    assert(extra.afterLine.notes.includes(NOTE), 'the note was lost');
    assertRaceViewsEqual(zero, extra, 'a note after the line');
});

check('in an event that ends on the clock nobody is counted as coming in, whatever the packet order', () => {
    const riders = [
        {id: 2001, gap: 0.3, group: 0, name: 'always'},
        {id: 3001, gap: 25, group: 1, name: 'always'},
        {id: 3002, gap: 25.3, group: 1, name: 'always'},
        {id: 8000, gap: 5, group: 1, subgroup: 1234, name: 'always'},
    ];
    for (const timing of [{selfPhase: 100, groupsPhase: 600}, {selfPhase: 600, groupsPhase: 100}]) {
        const {rec} = recordLine(120, {...timing, metric: 'time', riders});
        const al = rec.afterLine;
        assertEq(al.finishMetric, 'time');
        assertEq(al.arrivals.length, 0, `riders were counted in: ${JSON.stringify(al.arrivals)}`);
        assertEq(al.stillOnRoad, 0);
        assertEq(al.behindWhenClockRanOut.map(x => x.rider).join(','), '2001,3001,3002',
                 `timing ${JSON.stringify(timing)}`);
        const m = buildReport(rec, {});
        const text = m.sections.find(x => x.id === 'afterline').lines.join(' ');
        assert(!/reached the line behind you|came in (between|\d)/.test(text), text);
        assert(text.includes('When the clock ran out, Sauce had 3 riders of this event behind you'), text);
        assert(text.includes('Exact finish times and places come from the official results'), text);
        const part = buildFactPack(rec, {model: m}).match(/=== AFTER THE LINE ===[\s\S]*?(?=\n\n===)/)[0];
        assert(!part.includes('came in at'), part);
        assert(part.includes('behind the rider on the road when the clock ran out: 3'), part);
    }
});

check('a rider seen again after a gap in sightings is not counted as coming in', () => {
    // Out of Sauce's view from second 100 until 40 s after the line, crossing the line unseen.
    const riders = [...LINE_RIDERS, {id: 7001, gap: 30, group: 2, hidden: [100, 291], name: 'always'}];
    const {rec} = recordLine(120, {riders});
    const keys = rec.afterLine.arrivals.map(x => x.rider);
    assert(!keys.includes('7001'), `a rider last seen minutes earlier was counted in: ${keys}`);
    assert(!rec.afterLine.riders['7001'], 'a rider who was not counted in was kept');
    assert(keys.includes('3001'), `the chase group was lost: ${keys}`);
});

check('riders a fraction of a second behind are counted even when their crossing arrives first', () => {
    const riders = [{id: 2001, gap: 0.3, group: 0, name: 'always'},
                    {id: 2002, gap: 0.8, group: 0, name: 'always'}];
    for (const finishLateMs of [0, 600]) {
        const {rec} = recordLine(120, {selfPhase: 700, groupsPhase: 0, finishLateMs, riders});
        const got = rec.afterLine.arrivals.map(x => [x.rider, x.gap]);
        assertEq(JSON.stringify(got), JSON.stringify([['2001', 0.3], ['2002', 0.8]]),
                 `finish packet ${finishLateMs} ms late`);
        for (const x of rec.afterLine.arrivals) {
            assert(x.t >= rec.afterLine.finishRaceSecond, `a rider came in at ${x.t}, before the line`);
        }
    }
    // A rider behind who crossed well before the rider's own finish packet is not one of them.
    const early = recordLine(120, {selfPhase: 700, groupsPhase: 0, finishLateMs: 3500, riders}).rec;
    assert(early.afterLine.arrivals.length <= 2);
});

check('with no remaining on the riders behind, nobody is counted in or called still out', () => {
    const {rec} = recordLine(120, {riders: LINE_RIDERS, ridersCarryRemaining: false});
    const al = rec.afterLine;
    assertEq(al.ridersReportedFinish, false);
    assertEq(al.arrivals.length, 0);
    assertEq(al.stillOnRoad, 0);
    const text = buildReport(rec, {}).sections.find(x => x.id === 'afterline').lines.join(' ');
    assert(text.includes('it did not say whether any of them had reached the line'), text);
    assert(!text.includes('had not reached the line yet'), text);
});

check('riders in view after the line who never come in are neither kept nor looked up', () => {
    let offered = null;
    const feed = {
        riders: [
            ...LINE_RIDERS,
            {id: 8000, gap: 5, group: 1, subgroup: 1234, name: 'always'},
            {id: 8001, gap: 6, group: 1, subgroup: 1234, name: 'never'},
            {id: 3009, gap: 500, group: 2, name: 'never'},
        ],
        onSecond: (s, r) => (s === 280 ? (offered = r.unnamedRiderIds()) : null),
    };
    const {rec} = recordLine(120, feed);
    for (const id of [8000, 8001, 3009]) {
        assert(!offered.includes(id), `rider ${id} was offered to the name lookup after the line`);
        assert(!JSON.stringify(rec.afterLine.riders).includes(String(id)), `rider ${id} was saved`);
    }
    assertEq(Object.keys(rec.afterLine.riders).length, 0,
             'riders already in the race were saved again after the line');
});

await checkAsync('a saved race with the extra time stays under the per-race size cap', async () => {
    const normal = JSON.stringify(RACE_120).length;
    assert(normal < 400_000, `a 25 minute race with two minutes after the line is ${Math.round(normal / 1024)} kB`);
    // A two hour race that has already stepped down the size ladder, with the longest extra time
    // the window offers. The size guard does not run after the line, so this is the case that
    // could go over.
    const {finished} = recordSynthetic({seconds: 7200, endDistance: 200000,
                                        afterSeconds: MAX_AFTER_LINE_SECONDS + 5,
                                        afterLineSeconds: MAX_AFTER_LINE_SECONDS});
    const rec = finished[0];
    assertEq(rec.degraded.selfRowInterval, 5, 'the race never reached the top of the size ladder');
    assertEq(rec.afterLine.secondsCaptured, MAX_AFTER_LINE_SECONDS);
    // The size ladder only runs with the localStorage fallback, so that is where this matters.
    const res = await localStore().save(rec);
    assert(res.ok, res.error);
    assert(res.entry.bytes < 400_000, `the saved race is ${Math.round(res.entry.bytes / 1024)} kB`);
});


/* ================================================================= 7. the gun */

section('7. the gun: race time counts from the scheduled start, whenever Zwift\'s own clock starts');

// A gun race (runGunRace in synthetic-feed.mjs) recorded the way ui.mjs records: with the gun clock
// on. `states` is the recorder's state after each gun second's packets.
function recordGun(feed = {}, options = {}) {
    const clock = new FakeClock();
    const finished = [];
    const lines = [];
    const states = new Map();
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x),
                            onLine: x => lines.push(JSON.parse(JSON.stringify(x))),
                            gunClock: true, ...options});
    runGunRace(r, clock, {...feed, onSecond: s => states.set(s, r.state)});
    return {rec: finished[0], recorder: r, states, lines};
}

// Sauce's own per-second arrays for a gun race: they begin when Sauce opens its slice, usually on
// the packet where state.time first reads non-zero (src/stats.mjs:3050-3058), on Sauce's own time
// base, which counts from the createdServerTime the payloads carry (gunStreamTime).
function gunStreams(from, to) {
    const s = {time: [], power: [], hr: [], cadence: [], speed: [], draft: [], distance: [],
               altitude: [], wbal: []};
    for (let t = from; t <= to; t++) {
        s.time.push(gunStreamTime(t));
        s.power.push(gunRacePowerAt(t));
        s.hr.push(150);
        s.cadence.push(88);
        s.speed.push(36);
        s.draft.push(20);
        s.distance.push(t * 10);
        s.wbal.push(18000);
    }
    return s;
}

const withGunExtras = (rec, from = 67, to = 600) => ({
    ...rec,
    event: makeEventInfo(),
    self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5},
    stats: makeEventSliceStatsV1({elapsedTime: to - from + 1, activeTime: to - from, followTime: 400,
                                  workTime: 100, soloTime: to - from - 499}),
    streams: gunStreams(from, to),
    sauce: {version: '2.3.3'},
});

const GUN = recordGun();

check('the recording counts from the scheduled start while Zwift\'s clock starts 67 s late', () => {
    const rec = GUN.rec;
    assert(rec, 'no recording was produced');
    assertEq(rec.stopReason, 'finish');
    assertEq(rec.gunSource, 'scheduled-start');
    assertEq(rec.scheduledStartISO, '2026-09-16T09:40:00.000Z');
    assertEq(rec.clock, 'race');
    assertEq(rec.startedAtRaceSecond, 1);
    assertEq(rec.timeline.t[0], 1);
    assertEq(rec.timeline.t[rec.timeline.t.length - 1], 600);
    assertEq(rec.timeline.t.length, 600, 'a second of the race is missing or doubled');
    // The rider was moving from the gun while Zwift's clock still read 0.
    assertEq(rec.timeline.speed[0], 36);
    assertEq(rec.timeline.stateTime[0], 0);
    assertEq(rec.timeline.stateTime[65], 0);
    assertEq(rec.timeline.t[66], 67);
    assertEq(rec.timeline.stateTime[66], 1);
    assertEq(rec.zwiftClockStartedAtRaceSecond, 67);
    // Every row carries state.time as it was, so the file alone shows the two clocks.
    for (let i = 0; i < rec.timeline.t.length; i++) {
        const st = rec.timeline.stateTime[i];
        assert(st === 0 ? rec.timeline.t[i] < 67 : rec.timeline.t[i] - st === 66,
               `row ${i}: t ${rec.timeline.t[i]} against state.time ${st}`);
    }
    assertEq(rec.incomplete, false, `incomplete because: ${rec.incompleteReasons.join('; ')}`);
    assertEq(rec.notes.length, 0, `unexpected notes: ${rec.notes.join(' | ')}`);
    assertEq(rec.coverage.startSecond, 1);
    assertEq(rec.coverage.missingSeconds, 0);
});

check('nothing is recorded in the start pen before the scheduled start', () => {
    assertEq(GUN.states.get(-30), 'idle');
    // The pen packet at the gun itself is not after it.
    assertEq(GUN.states.get(0), 'idle', 'it started on the gun packet, before the gun had passed');
    assertEq(GUN.states.get(1), 'recording', 'it did not start once the gun had passed');
    assert(GUN.rec.timeline.t.every(t => t >= 1), 'a row from the pen is in the recording');
    assert(GUN.rec.pack.t.every(t => t >= 1), 'a pack row from the pen is in the recording');
});

check('the server clock is measured from the payload and saved', () => {
    assertEq(GUN.rec.timeSource, 'sauce-server-clock');
    assertEq(GUN.rec.serverClockOffsetMs, 0);
    assertEq(GUN.rec.serverClockOffsetMsLast, 0);
    // worldTime plus Zwift's epoch is Sauce's server time (src/zwift.mjs:111-113); updated is the
    // same moment on the computer's clock (src/stats.mjs:3495).
    const p = makeSelfPayload({t: 1, stateTime: 0, eventSubgroupId: 999, localMs: GUN_SERVER_MS,
                               serverOffsetMs: -2500});
    assertEq(p.state.worldTime + ZWIFT_EPOCH_MS, GUN_SERVER_MS - 2500);
    assertEq(serverClockOffset(p), -2500);
    // The placeholder clocks older tests send are not mistaken for a measurement.
    assertEq(serverClockOffset(makeSelfPayload({t: 1, stateTime: 0})), null);
    assertEq(serverClockOffset({updated: 5, state: {}}), null);
});

check('Sauce\'s streams, which start on Zwift\'s clock, join the mod\'s rows on the gun clock with no second twice', () => {
    const rec = withGunExtras(GUN.rec);
    const own = ownSeries(rec);
    assertEq(own.source, 'sauce-streams');
    assertEq(own.rowsBeforeStreams, 66, 'the mod\'s rows before Zwift\'s clock were not used');
    assertEq(own.t[0], 1);
    assertEq(own.t[65], 66);
    assertEq(own.t[66], 67, 'Sauce\'s streams are not on the race second Zwift\'s clock started');
    assertEq(own.t[own.t.length - 1], 600);
    assertEq(own.t.length, 600, 'a second is counted twice or lost where the two join');
    for (let i = 1; i < own.t.length; i++) {
        assert(own.t[i] > own.t[i - 1], `second ${own.t[i]} comes twice`);
    }
    for (const k of ['power', 'hr', 'cadence', 'speed', 'draft', 'distance', 'wbal', 'grade',
                     'eventDistance']) {
        assertEq(own[k].length, own.t.length, `${k} does not line up with the times`);
    }
    assertEq(own.power[0], GUN.rec.timeline.power[0]);
    assertEq(own.power[66], gunRacePowerAt(67));
    assertEq(own.power[599], gunRacePowerAt(600));
    // A recording that counts from state.time keeps the alignment it always had.
    const old = ownSeries({...rec, gunSource: 'zwift-clock'});
    assertEq(old.t[0], 0);
    assertEq(old.rowsBeforeStreams, 0);
});

check('the report and the copied text cover from the gun and say plainly when Zwift\'s clock started', () => {
    const rec = withGunExtras(GUN.rec);
    const m = buildReport(rec, {});
    const head = m.sections.find(x => x.id === 'race').lines.join(' ');
    assert(head.includes('Race times count from the gun, the scheduled start of your category'), head);
    assert(head.includes('This report covers from 0:01 to 10:00'), head);
    const start = m.sections.find(x => x.id === 'start').lines.join(' ');
    assert(start.includes('Zwift\'s race clock for you started 67 seconds after the gun.'), start);
    assert(start.includes('begins with that clock, at 1:07'), start);
    assert(start.includes('The first minute averaged'), `the start is not described from the gun: ${start}`);
    const draft = m.sections.find(x => x.id === 'draft').lines.join(' ');
    assert(draft.includes('not the 67 seconds before it'), draft);
    const fp = buildFactPack(rec, {model: m});
    assert(fp.includes('Scheduled start of the category (the gun): 2026-09-16T09:40:00.000Z'), fp);
    assert(fp.includes('Zwift\'s race clock for the rider started 67 seconds after the gun.'), fp);
    assert(fp.includes('No reason for this is known'), 'the AI is not told not to guess why');
    assert(fp.includes('Sauce\'s own record starts at 1:07'), fp);
    // No reason is given for the late clock, in either.
    const all = (JSON.stringify(m) + fp).toLowerCase();
    for (const guess of ['start line', 'because zwift', 'lag', 'bug']) {
        assert(!all.includes(guess), `a reason is guessed at: "${guess}"`);
    }
    // A clock within a few seconds of the gun is not mentioned.
    const onTime = recordGun({zwiftClockAt: 3}).rec;
    const mm = buildReport(withGunExtras(onTime, 3), {});
    assert(!JSON.stringify(mm).includes('race clock for you started'), 'a clock on time was called late');
    assert(!buildFactPack(withGunExtras(onTime, 3), {model: mm}).includes('race clock for the rider'));
});

check('a late join at the gun plus 300 s starts then, counts from the gun, and says so', () => {
    const {rec, states} = recordGun({joinAt: 300, zwiftClockAt: 305, seconds: 900});
    assert(rec, 'no recording was produced');
    assertEq(states.get(299), 'idle', 'it recorded the ride before the rider joined');
    assertEq(rec.startedAtRaceSecond, 300);
    assertEq(rec.joinedAtRaceSecond, 300);
    assertEq(rec.timeline.t[0], 300);
    assertEq(rec.zwiftClockStartedAtRaceSecond, 305);
    assert(rec.notes.some(x => x.includes('joined this event 300 seconds after the gun')),
           `the note is missing: ${JSON.stringify(rec.notes)}`);
    assertEq(rec.incomplete, false, `incomplete because: ${rec.incompleteReasons.join('; ')}`);
    const m = buildReport(withGunExtras(rec, 305, 900), {});
    const start = m.sections.find(x => x.id === 'start').lines.join(' ');
    assert(start.includes('You joined this event 5m 00s after the gun'), start);
    assert(!start.includes('not watching for the first'), `a late join reads as a late window: ${start}`);
    assert(!start.includes('seconds after the gun.') || !start.includes('race clock'),
           `Zwift's clock five seconds after the join is called late: ${start}`);
    const fp = buildFactPack(withGunExtras(rec, 305, 900), {model: m});
    assert(fp.includes('joined the event 300 seconds after the gun'), fp);
    assert(!fp.includes('only started watching'), fp);
    // A window whose first payload already has the rider in the event cannot date a join, and
    // does not: it is a window that came up late.
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), gunClock: true});
    let seen = 0;
    runGunRace({
        setScheduledStart: (id, ms) => r.setScheduledStart(id, ms),
        onSelf: p => (p.eventSubgroupId != null && ++seen >= 10 ? r.onSelf(p) : 'ok'),
        onGroups: g => (seen >= 10 ? r.onGroups(g) : undefined),
    }, clock, {joinAt: 300, zwiftClockAt: 305, seconds: 900});
    assertEq(finished[0].startedAtRaceSecond, 309);
    assertEq(finished[0].joinedAtRaceSecond, null, 'a window that came up late dated a join');
    assert(finished[0].incompleteReasons.some(x => x.includes('309 seconds after the gun')),
           JSON.stringify(finished[0].incompleteReasons));
});

check('with no scheduled start it counts from Zwift\'s clock as before, and says so', () => {
    const {rec, states} = recordGun({scheduledStart: false});
    assertEq(states.get(66), 'idle', 'it started in the pen with nothing to say the gun had gone');
    assertEq(states.get(67), 'recording');
    assertEq(rec.gunSource, 'zwift-clock');
    assertEq(rec.scheduledStartISO, null);
    assertEq(rec.startedAtRaceSecond, 1);
    assertEq(rec.timeline.t[0], 1);
    assertEq(rec.timeline.stateTime[0], 1);
    assertEq(rec.zwiftClockStartedAtRaceSecond, null);
    assert(rec.notes.some(x => x.includes('did not have the scheduled start')),
           `the note is missing: ${JSON.stringify(rec.notes)}`);
    const m = buildReport(withGunExtras(rec), {});
    assert(m.notes.some(x => x.includes('not from the gun')), 'the report does not say so');
    assert(buildFactPack(withGunExtras(rec), {model: m}).includes('did not have the scheduled start'));
    // The recorder on its own, as every older test uses it, ignores a scheduled start entirely.
    const plain = recordGun({}, {gunClock: false}).rec;
    assertEq(plain.gunSource, 'zwift-clock');
    assertEq(plain.notes.length, 0);
    assertEq(new Recorder({}).gunClock, false);
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/gunClock: true/.test(ui), 'ui.mjs does not turn the gun clock on');
    assert(ui.includes('recorder.setScheduledStart(id, ms)'), 'ui.mjs does not hand the scheduled start over');
    const code = ui.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const lookup = code.match(/async function maybeLookUpScheduledStart[\s\S]*?\n\}/)[0] +
        code.match(/async function cachedSubgroup[\s\S]*?\n\}/)[0];
    assert(lookup.includes('getCachedEvents') && lookup.includes('getCachedEvent(') &&
           !lookup.includes('getEventSubgroup('), 'the scheduled start lookup can reach Zwift');
});

check('a computer clock a few seconds off Sauce\'s server clock does not move the gun', () => {
    for (const offset of [4000, -3000]) {
        const {rec, states} = recordGun({serverOffsetMs: offset});
        assertEq(rec.timeSource, 'sauce-server-clock');
        assertEq(rec.serverClockOffsetMs, offset);
        assertEq(states.get(0), 'idle', `offset ${offset}: it started before the gun`);
        assertEq(states.get(1), 'recording', `offset ${offset}: it did not start after the gun`);
        assertEq(rec.startedAt, GUN_SERVER_MS + 1000 - offset);
        assertEq(JSON.stringify(rec.timeline.t), JSON.stringify(GUN.rec.timeline.t), `offset ${offset}: times moved`);
        assertEq(rec.zwiftClockStartedAtRaceSecond, 67);
    }
    // With no server clock in the data it uses the computer's and says so.
    const {rec} = recordGun({serverTime: false, serverOffsetMs: 4000});
    assertEq(rec.timeSource, 'computer-clock');
    assertEq(rec.serverClockOffsetMs, null);
    assert(rec.notes.some(x => x.includes('this computer\'s clock')), JSON.stringify(rec.notes));
});

check('treating the raw state.eventSubgroupId as in the event is not done: Sauce\'s own id starts it', () => {
    // Evaluated and not taken; see THE GUN in recorder.mjs. Sauce's own eventSubgroupId stays
    // missing until the subgroup has loaded (src/stats.mjs:3029-3036, :4343).
    const clock = new FakeClock(GUN_SERVER_MS + 5000);
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), gunClock: true});
    r.setScheduledStart(999, GUN_SERVER_MS);
    const p = makeSelfPayload({t: 5, stateTime: 5, eventSubgroupId: undefined, localMs: clock.t,
                               power: 250, speed: 36, eventDistance: 50, endDistance: 6000,
                               remainingType: 'route'});
    p.state.eventSubgroupId = 999;
    r.onSelf(p);
    assertEq(r.state, 'idle', 'a raw subgroup id alone started a recording');
});

check('after the line still works on the gun clock, and the race still ends at the line', () => {
    const zero = recordGun({afterSeconds: 125}, {afterLineSeconds: 0}).rec;
    const extra = recordGun({afterSeconds: 125}, {afterLineSeconds: 120});
    const rec = extra.rec;
    assertEq(rec.stopReason, 'finish');
    assertEq(extra.lines.length, 1, 'the race was not handed over at the line');
    assertEq(rec.afterLine.finishRaceSecond, 601);
    assertEq(rec.afterLine.secondsCaptured, 120);
    assertEq(rec.timeline.t[rec.timeline.t.length - 1], 600, 'the race rows run past the line');
    assert(rec.afterLine.timeline.stateTime.length === rec.afterLine.timeline.t.length,
           'state.time is not kept on the rows after the line');
    // Nobody is named here, so the pair 30 s back is found by its gap.
    const came = rec.afterLine.arrivals.find(x => x.gap === 30);
    assert(came, `the pair 30 s back did not come in: ${JSON.stringify(rec.afterLine.arrivals)}`);
    assertEq(came.t, 632);
    assertEq(rec.zwiftClockStartedAtRaceSecond, 67);
    assertRaceViewsEqual(withGunExtras(zero), withGunExtras(rec), 'the gun race');
    assert(buildReport(withGunExtras(rec), {}).sections.find(x => x.id === 'afterline').lines
        .join(' ').includes('after you crossed the line at 10:01'), 'the line is not on the gun clock');
});

// A gun race seen through a window that only receives self packets from gun second `from` on, with
// groups from the same second. The scheduled start reaches the recorder the way ui.mjs hands it
// over (startLookupAt), or never.
function recordGunWindow(from, feed = {}, options = {}) {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x),
                            gunClock: true, ...options});
    let open = false;
    runGunRace({
        setScheduledStart: (id, ms) => r.setScheduledStart(id, ms),
        onSelf: p => {
            open = open || clock.t - GUN_SERVER_MS >= from * 1000;
            return open ? r.onSelf(p) : 'ok';
        },
        onGroups: g => (open ? r.onGroups(g) : undefined),
    }, clock, feed);
    return {rec: finished[0], recorder: r};
}

check('a recording that started on Zwift\'s clock before the scheduled start arrived is moved onto the gun', () => {
    // A window opened (or reloaded, or Sauce restarted) at gun second 400. ui.mjs asks for the
    // scheduled start after the first payload, so that payload starts a recording on Zwift's
    // clock; the answer lands before the next one.
    const late = recordGunWindow(400, {startLookupAt: 400});
    const known = recordGunWindow(400, {});
    for (const {rec} of [late, known]) {
        assertEq(rec.gunSource, 'scheduled-start');
        assertEq(rec.scheduledStartISO, '2026-09-16T09:40:00.000Z');
        assertEq(rec.startedAtRaceSecond, 400);
        assertEq(rec.timeline.t[0], 400);
        assertEq(rec.zwiftClockStartedAtRaceSecond, 67);
    }
    const rec = late.rec;
    assert(!rec.notes.some(x => x.includes('did not have the scheduled start')),
           `the fallback note stayed: ${JSON.stringify(rec.notes)}`);
    // Moved exactly: the same rows, pack rows, riders and completeness as a recorder that had the
    // scheduled start from its first payload.
    for (const k of ['timeline', 'pack', 'riders', 'incompleteReasons', 'coverage', 'afterLine']) {
        assertEq(JSON.stringify(rec[k]), JSON.stringify(known.rec[k]), `${k} differs after the move`);
    }
    assert(rec.incompleteReasons.some(x => x.includes('400 seconds after the gun')),
           JSON.stringify(rec.incompleteReasons));
    // Sauce's streams line up the same way on both.
    const own = ownSeries(withGunExtras(rec));
    assertEq(own.t[0], 67);
    assertEq(own.power[own.t.indexOf(400)], gunRacePowerAt(400));
    // Sauce's record begins with Zwift's late clock, so it is not called the whole race.
    const m = buildReport(withGunExtras(rec), {});
    const head = m.sections.find(x => x.id === 'race').lines.join(' ');
    assert(head.includes('come from Sauce\'s own record and begin at 1:07') && !head.includes('whole race'), head);
    const fp = buildFactPack(withGunExtras(rec), {model: m});
    assert(fp.includes('per-second record, which begins at 1:07') && !fp.includes('complete per-second'), fp);
    // Moved before the line only, and the race still ends at the line with extra time running.
    const extra = recordGunWindow(400, {startLookupAt: 400, afterSeconds: 125}, {afterLineSeconds: 120});
    assertEq(extra.rec.afterLine.finishRaceSecond, 601);
    assertEq(extra.rec.timeline.t[extra.rec.timeline.t.length - 1], 600);
    // A scheduled start that never comes leaves it on Zwift's clock, with its note.
    const never = recordGunWindow(400, {scheduledStart: false});
    assertEq(never.rec.gunSource, 'zwift-clock');
    assertEq(never.rec.startedAtRaceSecond, 334);
    assert(never.rec.notes.some(x => x.includes('did not have the scheduled start')));
    // A late join with Zwift's clock already running, handed the start one payload late.
    const {rec: joined} = recordGun({joinAt: 300, joinStateTime: 4300, seconds: 900, startLookupAt: 300});
    assertEq(joined.gunSource, 'scheduled-start');
    assertEq(joined.startedAtRaceSecond, 300);
    assertEq(joined.joinedAtRaceSecond, 300);
    assertEq(joined.incomplete, false, `incomplete because: ${joined.incompleteReasons.join('; ')}`);
});

check('a Sauce subgroup id left over from the previous event does not start a recording in the next pen', () => {
    // Sauce keeps the previous subgroup until the new one has loaded (src/stats.mjs:3030-3036).
    for (const gunClock of [true, false]) {
        const clock = new FakeClock();
        const r = new Recorder({now: () => clock.now(), gunClock});
        r.setScheduledStart(888, GUN_SERVER_MS - 2 * 3600 * 1000);
        r.setScheduledStart(999, GUN_SERVER_MS);
        for (let s = -300; s <= -290; s++) {
            clock.t = GUN_SERVER_MS + s * 1000;
            const p = makeSelfPayload({t: s, stateTime: 0, eventSubgroupId: 888, power: 0, speed: 0,
                                       eventDistance: 0, localMs: clock.t, remainingType: 'route'});
            p.state.eventSubgroupId = 999;
            r.onSelf(p);
            assertEq(r.state, 'idle', `gunClock ${gunClock}: recording in the next event's pen`);
        }
        // Nor on Zwift's clock running while the two disagree, with the gun clock on.
        if (gunClock) {
            clock.t = GUN_SERVER_MS + 30000;
            const p = makeSelfPayload({t: 30, stateTime: 30, eventSubgroupId: 888, power: 250,
                                       speed: 36, eventDistance: 300, localMs: clock.t,
                                       remainingType: 'route'});
            p.state.eventSubgroupId = 999;
            r.onSelf(p);
            assertEq(r.state, 'idle', 'a stale subgroup started a recording on Zwift\'s clock');
        }
    }
});

check('a late join from Zwift\'s home screen, with nothing before it, is a join and not a late window', () => {
    const listening = GUN_SERVER_MS - 15 * 60 * 1000;
    const {rec} = recordGun({joinAt: 300, joinFromHome: true, zwiftClockAt: 305, seconds: 900,
                             startLookupAt: 300}, {listeningSince: listening});
    assertEq(rec.joinedAtRaceSecond, 300);
    assertEq(rec.startedAtRaceSecond, 301);
    assertEq(rec.incomplete, false, `incomplete because: ${rec.incompleteReasons.join('; ')}`);
    const m = buildReport(withGunExtras(rec, 305, 900), {});
    const all = JSON.stringify(m);
    assert(!all.includes('not watching for the first'), 'a home screen join reads as a late window');
    assert(!all.includes('race clock for you started'), 'Zwift\'s clock is measured from the gun, not the join');
    // Not a join: a window that only started listening after the gun, or one with no listening
    // time at all, or a rider already well into the event on the first payload.
    const after = recordGun({joinAt: 300, joinFromHome: true, zwiftClockAt: 305, seconds: 900},
                            {listeningSince: GUN_SERVER_MS + 200000}).rec;
    assertEq(after.joinedAtRaceSecond, null);
    assertEq(recordGun({joinAt: 300, joinFromHome: true, zwiftClockAt: 305, seconds: 900}).rec
        .joinedAtRaceSecond, null);
    const deep = recordGunWindow(400, {}, {listeningSince: listening}).rec;
    assertEq(deep.joinedAtRaceSecond, null, 'a rider 4 km into the race was taken for a join');
    assert(deep.incompleteReasons.some(x => x.includes('400 seconds after the gun')));
});

check('a late join whose Sauce subgroup id arrives 30 s after the game\'s is measured against the join', () => {
    const {rec} = recordGun({joinAt: 300, zwiftClockAt: 305, seconds: 900, sauceIdLag: 30});
    assertEq(rec.joinedAtRaceSecond, 300);
    assertEq(rec.startedAtRaceSecond, 330);
    assertEq(rec.incompleteReasons.length, 1, JSON.stringify(rec.incompleteReasons));
    assert(rec.incompleteReasons[0].includes('30 seconds after you joined'), rec.incompleteReasons[0]);
    assert(rec.notes.some(x => x.includes('only starts 30 seconds after that')), JSON.stringify(rec.notes));
    assert(!rec.notes.some(x => x.includes('so this recording starts there')), JSON.stringify(rec.notes));
    const m = buildReport(withGunExtras(rec, 305, 900), {});
    const all = JSON.stringify(m);
    assert(!all.includes('This window only started watching'), all);
    assert(!all.includes('race clock for you started'), 'Zwift\'s clock 5 s after the join is called late');
    assert(all.includes('This recording only started at 5:30, 30s after you joined'), all);
    const fp = buildFactPack(withGunExtras(rec, 305, 900), {model: m});
    assert(fp.includes('30 seconds after the rider joined'), fp);
    assert(!fp.includes('so the record starts there'), fp);
});

check('Sauce\'s streams go on the gun clock by their own server time, not by when Zwift\'s clock read 1', () => {
    // Joined at 300 with the session's state.time still running: Zwift's clock is never put
    // before the join.
    const {rec} = recordGun({joinAt: 300, joinStateTime: 4300, seconds: 900});
    assertEq(rec.zwiftClockStartedAtRaceSecond, 300);
    assertEq(rec.createdServerTime, GUN_CREATED_SERVER_MS);
    const own = ownSeries(withGunExtras(rec, 300, 900));
    assertEq(own.t[0], 300);
    assertEq(own.power[own.t.indexOf(450)], gunRacePowerAt(450));
    const m = buildReport(withGunExtras(rec, 300, 900), {});
    assertEq(m.meta.zwiftClockLate, null, 'Zwift\'s clock was put thousands of seconds before the gun');
    assert(!/-\d+:\d\d/.test(JSON.stringify(m.sections)), 'a time before the gun is in the report');
    // A rejoin: Sauce's slice opens again at 260 while Zwift's clock ran from 67. The streams are
    // placed where their samples were taken, whatever zwiftClockStartedAtRaceSecond says.
    const rejoin = {...GUN.rec, zwiftClockStartedAtRaceSecond: 67, streams: gunStreams(260, 600)};
    const o = ownSeries(rejoin);
    assertEq(o.t[o.rowsBeforeStreams], 260);
    assertEq(o.rowsBeforeStreams, 259);
    assertEq(o.power[o.t.indexOf(400)], gunRacePowerAt(400));
    // Samples before the gun are left out, like rows.
    const early = ownSeries({...GUN.rec, streams: gunStreams(-8, 600)});
    assertEq(early.t[0], 0);
    for (let i = 1; i < early.t.length; i++) {
        assert(early.t[i] > early.t[i - 1], `second ${early.t[i]} comes twice`);
    }
    // Without createdServerTime, as a recording made before it was saved, the old placement stays.
    const noCreated = ownSeries(withGunExtras({...GUN.rec, createdServerTime: null}));
    assertEq(noCreated.t[66], 67);
});

check('Zwift\'s clock starting before the scheduled start does not start the recording early', () => {
    const {rec, states} = recordGun({zwiftClockAt: -7});
    assertEq(states.get(0), 'idle', 'it started before the scheduled start');
    assertEq(states.get(1), 'recording');
    assert(rec.timeline.t.every(t => t >= 0), 'a row before the gun is in the recording');
    assertEq(rec.zwiftClockStartedAtRaceSecond, -7);
    const m = buildReport(withGunExtras(rec, -7), {});
    const start = m.sections.find(x => x.id === 'start').lines.join(' ');
    assert(start.includes('started 7 seconds before the scheduled start'), start);
    assert(!/-\d+:-\d/.test(JSON.stringify(m)), 'a negative time is printed as -1:-8');
    assertEq(fmtClock(-8), '-0:08');
    assertEq(fmtClock(-75), '-1:15');
    assertEq(fmtClock(75), '1:15');
    // The gun is judged on the state's own server time, not on when the payload arrived: a pen
    // state from 200 ms before the gun that reaches the window 200 ms after it is still the pen.
    const clock = new FakeClock(GUN_SERVER_MS + 200);
    const r = new Recorder({now: () => clock.now(), gunClock: true});
    r.setScheduledStart(999, GUN_SERVER_MS);
    r.onSelf(makeSelfPayload({t: 0, stateTime: 0, eventSubgroupId: 999, power: 0, speed: 0,
                              eventDistance: 0, endDistance: 1000, localMs: GUN_SERVER_MS - 200}));
    assertEq(r.state, 'idle', 'a pen state from before the gun started the recording');
});

check('a scheduled start that changes is used until a recording counts from it, then kept', () => {
    // Moved five minutes later while the rider waits: nothing is recorded before the new time.
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), gunClock: true});
    const moved = GUN_SERVER_MS + 300000;
    const recStates = new Map();
    runGunRace({
        setScheduledStart: id => r.setScheduledStart(id, GUN_SERVER_MS),
        onSelf: p => {
            if (clock.t === GUN_SERVER_MS - 100000) {
                r.setScheduledStart(999, moved);   // ui.mjs's minute refresh brings the new start
            }
            return r.onSelf(p);
        },
        onGroups: g => r.onGroups(g),
    }, clock, {penSeconds: 400, onSecond: s => recStates.set(s, r.state)});
    assertEq(recStates.get(-50), 'idle');
    assertEq(recStates.get(299), 'idle', 'it recorded before the moved start');
    assertEq(recStates.get(301), 'recording');
    assertEq(finished[0].scheduledStartISO, new Date(moved).toISOString());
    // Once a recording counts from a scheduled start it keeps it, and ui.mjs stops asking.
    const c2 = new FakeClock();
    const r2 = new Recorder({now: () => c2.now(), gunClock: true});
    runGunRace(r2, c2, {seconds: 100, onSecond: s => {
        if (s === 50) {
            assert(r2.usesScheduledStart(999), 'a recording on the gun is not reported as using it');
            r2.setScheduledStart(999, GUN_SERVER_MS + 60000);
            assertEq(r2.rec.scheduledStartISO, '2026-09-16T09:40:00.000Z');
            assertEq(r2.rec.startedAtRaceSecond, 1);
        }
    }});
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/SCHEDULE_REFRESH_SECONDS/.test(ui) && ui.includes('recorder.usesScheduledStart(id)'),
           'ui.mjs does not read a known scheduled start again');
    assert(/listeningSince: startedAt/.test(ui), 'ui.mjs does not tell the recorder when it began listening');
});

// The real recording of 16 Sep 2026, read only for its field shapes and numbers. Never written.
const REAL_FILE = Path.resolve(MOD_DIR, '..',
    'race-report-Stage-2-Zwift-Crit-Club-DURA-ACE-Mech-Isle-Loop-2026-09-16-09-41-07.json');
if (FS.existsSync(REAL_FILE)) {
    const REAL = JSON.parse(FS.readFileSync(REAL_FILE, 'utf8'));

    check('the real recording of 16 Sep 2026, replayed with its scheduled start, counts from 09:40:00', () => {
        // Its rows were on state.time (startedAtRaceSecond 1, so t equals state.time), arriving
        // one a second from startedAt. Before them the rider rode out of the pen from the gun
        // with state.time still 0, at the speed of the first real row.
        const T = Date.parse('2026-09-16T09:40:00Z');
        assertEq(REAL.startedAtRaceSecond, 1);
        assertEq(REAL.eventSubgroupId, 7327532);
        const tl = REAL.timeline;
        const clock = new FakeClock();
        const finished = [];
        const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), gunClock: true});
        r.setScheduledStart(REAL.eventSubgroupId, T);
        const endDistance = REAL.event.endDistance;
        // Sauce's peaks carry ts = toLocalTime(wtOffset) + time * 1000 (src/stats.mjs:196-247),
        // so the real file gives the moment its stream times count from. The computer clock is
        // taken as the server's here, as everywhere else in this replay.
        const pk = REAL.stats.power.peaks['5'];
        const createdServerTime = pk.ts - pk.time * 1000;
        assertEq(Math.floor((createdServerTime + REAL.streams.time[0] * 1000 - T) / 1000), 67,
                 'Sauce\'s first real stream sample is not in race second 67');
        const base = {eventSubgroupId: REAL.eventSubgroupId, hr: tl.hr[0], cadence: 0, draft: 0,
                      grade: 0, wBal: 20000, eventPosition: 9, eventParticipants: 10,
                      activePowerUp: null, endDistance, createdServerTime};
        const states = new Map();
        for (let s = -20; s <= 66; s++) {
            clock.t = T + s * 1000;
            const moving = s > 0;
            r.onSelf(makeSelfPayload({...base, t: s, stateTime: 0, localMs: clock.t,
                                      power: moving ? tl.power[0] : 0, speed: moving ? tl.speed[0] : 0,
                                      distance: 0, eventDistance: 0}));
            states.set(s, r.state);
        }
        for (let i = 0; i < tl.t.length; i++) {
            clock.t = REAL.startedAt + (tl.t[i] - 1) * 1000;
            r.onSelf(makeSelfPayload({...base, t: tl.t[i], stateTime: tl.t[i], localMs: clock.t,
                                      power: tl.power[i], hr: tl.hr[i], cadence: tl.cadence[i],
                                      speed: tl.speed[i], draft: tl.draft[i], distance: tl.distance[i],
                                      eventDistance: tl.eventDistance[i], grade: tl.grade[i],
                                      wBal: tl.wbal[i], eventPosition: tl.eventPosition[i],
                                      eventParticipants: tl.eventParticipants[i]}));
        }
        // It ended with Sauce no longer showing the rider in the event, as the real one did.
        clock.t += 1000;
        r.onSelf(makeSelfPayload({...base, t: 0, stateTime: 0, localMs: clock.t, eventSubgroupId: undefined,
                                  power: 0, speed: 0, remainingType: 'route'}));
        const rec = finished[0];
        assert(rec, 'no recording was produced');
        assertEq(states.get(0), 'idle', 'it recorded in the pen before 09:40:00');
        assertEq(states.get(1), 'recording');
        assertEq(rec.stopReason, REAL.stopReason);
        assertEq(rec.scheduledStartISO, '2026-09-16T09:40:00.000Z');
        assertEq(rec.startedAtRaceSecond, 1);
        assertEq(rec.zwiftClockStartedAtRaceSecond, 67, 'the real 67 s is not what the file shows');
        assertEq(rec.timeline.t[66], 67);
        assertEq(rec.timeline.stateTime[66], 1);
        assertEq(rec.timeline.t[rec.timeline.t.length - 1], 66 + tl.t[tl.t.length - 1]);
        assertEq(rec.timeline.power[66], tl.power[0]);
        // Every field the real file has, the new recording still has, so nothing reading it breaks.
        for (const k of Object.keys(REAL)) {
            if (k !== 'sliceWindow') {   // attached by ui.mjs, not the recorder
                assert(k in rec, `the recording lost the field ${k}`);
            }
        }
        for (const k of Object.keys(REAL.timeline)) {
            assert(k in rec.timeline, `the timeline lost ${k}`);
        }
        assertEq(Object.keys(rec.pack).join(), Object.keys(REAL.pack).join());
        // With Sauce's real stats and streams attached, as ui.mjs attaches them.
        const full = {...rec, event: REAL.event, self: REAL.self, stats: REAL.stats,
                      streams: REAL.streams, sauce: REAL.sauce};
        const own = ownSeries(full);
        assertEq(own.source, 'sauce-streams');
        assertEq(own.rowsBeforeStreams, 66);
        assertEq(own.t[66], 67);
        assertEq(rec.createdServerTime, createdServerTime);
        assertEq(own.t.length, 66 + REAL.streams.time.length);
        for (let i = 1; i < own.t.length; i++) {
            assert(own.t[i] > own.t[i - 1], `second ${own.t[i]} comes twice`);
        }
        const m = buildReport(full, {});
        const start = m.sections.find(x => x.id === 'start').lines.join(' ');
        assert(start.includes('Zwift\'s race clock for you started 67 seconds after the gun.'), start);
        const fp = buildFactPack(full, {model: m});
        assert(fp.includes('Zwift\'s race clock for the rider started 67 seconds after the gun.'), fp);
    });

    check('the real recording as it was saved still opens, on the clock it was saved on', () => {
        const m = buildReport(REAL, {});
        assertEq(m.meta.clock, 'race');
        assertEq(m.meta.gunSource, null);
        assertEq(ownSeries(REAL).t[0], 0, 'an older recording\'s alignment changed');
        assert(!JSON.stringify(m).includes('race clock for you started'),
               'a recording with no scheduled start in it claims a late clock');
        assert(buildFactPack(REAL, {model: m}).includes('=== RACE ==='));
    });
} else {
    console.log('  skip the real recording of 16 Sep 2026 (not found next to the mod)');
}

check('a best window averages over time, so samples 1.2 s apart do not inflate a short peak', () => {
    // Sauce's streams on 17 Sep 2026: a quarter of samples 1.2 s apart.
    const t = [];
    const v = [];
    for (let x = 0; x < 120; x += (t.length % 4 === 3 ? 1.2 : 1)) {
        t.push(x);
        v.push(x >= 50 && x < 55 ? 600 : 200);
    }
    const b = bestWindow(t, v, 5);
    assert(b.avg <= 600 + 1e-9, `best 5 s ${b.avg}`);
    // One a second rows with one second missing are not a full five seconds at 0.95 cover.
    const t2 = [0, 1, 2, 3, 5, 6, 7, 8];
    assertEq(bestWindow(t2, t2.map(() => 900), 5, {minCover: 0.95}), null);
});

check('the organiser\'s powerups are named from Sauce\'s {NAME: share} shape as well as a list', () => {
    const m = buildReport({...FULL, event: {...FULL.event, powerUps: {LIGHTNESS: 0.5, ANVIL: 0.5}}}, {});
    const lines = m.sections.find(s => s.id === 'powerups').lines.join('\n');
    assert(lines.includes('The organiser listed these powerups for the event: Feather, Anvil.'), lines);
});

// The real recording of 17 Sep 2026, a whole race to the line. Read only. Never written.
const REAL2_FILE = Path.resolve(MOD_DIR, '..',
    'race-report-Stage-2-ZRacing-DURA-ACE-Ocean-Lava-Cliffside-Lo-2026-09-17-07-11-00.json');
if (FS.existsSync(REAL2_FILE)) {
    const REAL2 = JSON.parse(FS.readFileSync(REAL2_FILE, 'utf8'));
    const m = buildReport(REAL2, {});
    const sec = id => m.sections.find(s => s.id === id);

    check('17 Sep 2026: the efforts are Sauce\'s own peaks, each where it started', () => {
        const rows = sec('efforts').table.rows;
        assertEq(rows[0].slice(0, 3).join(' | '), '5 s | 588 W | 6:24');
        assertEq(rows[1].slice(0, 3).join(' | '), '15 s | 530 W | 27:45');
        // Where is read at the start: the 60 s effort a second earlier is not further along.
        assert(parseFloat(rows[2][3]) <= parseFloat(rows[1][3]), JSON.stringify(rows));
        const debrief = buildFactPack(REAL2, {model: m, style: 'debrief'});
        assert(debrief.includes('  5 s: 588 W (6.8 W/kg), Sauce\'s peak from 6:24'), debrief.split('\n').filter(x => /^  \d+ s: /.test(x)).join('\n'));
    });

    check('17 Sep 2026: the organiser\'s powerups are named', () => {
        assert(sec('powerups').lines.some(x => x.includes('listed these powerups for the event: Feather, Anvil')),
               sec('powerups').lines.join('\n'));
    });

    check('17 Sep 2026: a split says where the riders went, and when they were back', () => {
        const [first, , third, last] = sec('shape').lines;
        assert(first.includes('the riders who left now in a group behind you'), first);
        assert(first.includes('All of them were back in your group by 2:30, 30s later.'), first);
        assert(last.includes('Riders now in a group behind you: '), last);
        // Two splits 46 s apart on the climb do not list the same riders twice.
        const names = l => l.split(': ').pop().replace(/ and \d+ more.*$|\..*$/, '').split(', ');
        const second = sec('shape').lines[1];
        assert(!names(third).some(x => names(second).includes(x)), `${second}\n${third}`);
    });

    check('17 Sep 2026: the finish gives the groups either side, and no "1 riders" or "change of nothing"', () => {
        const fin = sec('finish').lines.join('\n');
        assert(fin.includes('Sauce had nobody else in your group at that point, with a rider'), fin);
        assert(/a group of 2, 2\.6 seconds behind you/.test(fin), fin);
        const all = JSON.stringify(m);
        assert(!/\b1 riders\b/.test(all) && !all.includes('change of nothing'), 'plural slip');
    });

    check('17 Sep 2026: a split that came back together is one reason in the debrief, and none in the commentary', () => {
        const text = buildFactPack(REAL2, {model: m, style: 'debrief'});
        const why = text.split('\n').find(x => x.startsWith('Why: the start'));
        assert(/14 riders of it in a group behind you from 2:00( \([^)]*\))?, all back in your group by 2:30/.test(why), why);
        assert(!why.includes('from a group behind now in your group'), why);
        // Van, 18 Sep 2026: a split counts in the commentary only when it lasted more than 30 s.
        // The two early ones were back together after 30 s and 28 s.
        const whys = buildFactPack(REAL2, {model: m, style: 'commentary'}).split('\n').filter(x => x.startsWith('Why:'));
        assert(!whys.some(x => /back in your group by 2:30|by 3:21|from 18 to 4/.test(x)), whys.join('\n'));
    });
    // partOf is defined further down; this block runs before it.
    const sectionOf = (text, head) => {
        const at = text.indexOf(`=== ${head} ===`);
        const next = text.indexOf('\n=== ', at + 4);
        return at < 0 ? '' : text.slice(at, next < 0 ? undefined : next);
    };
    check('17 Sep 2026: the facts say when the move was the rider\'s, and only then', () => {
        // Van, 18 Sep 2026: his move at 28:10 read "as if they fell back instead of me attacking".
        const text = buildFactPack(REAL2, {model: m, style: 'commentary'});
        const why = text.split('\n').find(x => x.startsWith('Why:') && x.includes('the finish'));
        assert(why.includes('your move: you rode clear of your group at 28:10, 4 riders of it now behind you'), why);
        // At 14:01 one rider came off a group that stayed with the rider: not the rider's move.
        assert(!text.split('\n').some(x => x.startsWith('  14:01') && x.includes('your move')), 'a dropped rider read as the rider\'s move');
        assert(PROMPTS.commentary.includes('you may say the recording rider attacked or went clear. Never say it of anyone else.'));
    });

    check('17 Sep 2026: TERRAIN cuts the road where it changes, so the climb and the last kick show', () => {
        // A tester, 22 Sep 2026: the output "had no idea what terrain was like"; Van: a row a km
        // "doesn't seem frequent enough".
        const part = sectionOf(buildFactPack(REAL2, {model: m, style: 'commentary'}), 'TERRAIN');
        assert(/\| steep climb$/m.test(part) && part.includes('10.24-9.49'), part);
        assert(/^1\.54-1\.34 \| 27:41-28:00 \| 200 m \| \+6 m \| 3\.0% \| 3\.5% \| climb$/m.test(part), part);
        const rows = part.split('\n').filter(x => /^\d/.test(x));
        assert(rows.length >= 15 && rows.length <= 30, `${rows.length} stretches`);
        assert(!part.includes('-0.0%'), part);
    });

    check('17 Sep 2026: YOUR RACE STRETCH BY STRETCH tells the rider\'s race in order, by the road', () => {
        // A tester's write-up, 22 Sep 2026: "caught 1 rider on the lead up to the climb, then a few
        // riders on the climb... caught them early on the descent". Van: it belongs in the debrief.
        const deb = buildFactPack(REAL2, {model: m, style: 'debrief'});
        const part = sectionOf(deb, 'YOUR RACE STRETCH BY STRETCH');
        const rows = part.split('\n').slice(1);
        assert(rows.some(x => x.startsWith('climb 1, 13:4') && x.includes('now ahead of you (')), part);
        assert(rows.some(x => /the lead-up to climb 1/.test(x)), part);
        // Names are the real riders' and stay out of this public file: the shapes only.
        assert(rows.some(x => /1 rider from ahead now in your group \([^)]+\)/.test(x) && x.startsWith('rolling road')), part);
        assert(rows.some(x => /1 rider from behind now in your group \([^)]+\)/.test(x)), part);
        assert(rows.some(x => x.startsWith('the descent, ')), part);
        assert(!sectionOf(buildFactPack(REAL2, {model: m, style: 'commentary'}), 'YOUR RACE STRETCH BY STRETCH'),
               'the commentary is not about the rider');
        assert(PROMPTS.debrief.includes('Your race, start to finish'));
    });

    check('17 Sep 2026: changes of group say who moved where the data shows it', () => {
        // A tester, 22 Sep 2026: "It struggled quite a bit understanding who was catching vs getting dropped."
        const text = buildFactPack(REAL2, {model: m, style: 'commentary'});
        const line = t => text.split('\n').find(x => x.startsWith(`  ${t}: `)) || '';
        assert(line('14:01').includes('they were dropped'), line('14:01'));
        assert(line('15:05').includes('they rode clear'), line('15:05'));
        assert(line('2:30').includes('they came back as your power fell'), line('2:30'));
        // The group of seven ahead splitting at 28:21, said as such.
        assert(/28:21: the group ahead split: [^\n]* were now further up the road, and [^\n]* was left as the nearest group ahead of yours/.test(text),
               text.split('\n').filter(x => x.includes('28:2')).join('\n'));
    });

    check('17 Sep 2026: a split is a commentary moment only when it lasted more than the threshold', () => {
        const ctx = raceContext(REAL2, {model: m});
        const tags = n => findMoments(ctx, {efforts: [], climbs: [], minSplitSeconds: n}).moments.flatMap(x => x.tags).join('; ');
        // The 2:00 split was back together after exactly 30 s.
        assert(/from 2:00( \([^)]*\))?, all back in your group by 2:30/.test(tags(29)), tags(29));
        assert(!tags(30).includes('from 2:00'), tags(30));
    });

    check('17 Sep 2026: THE RACE IN BRIEF gives the field, the winner and where it came apart; your place only in the debrief', () => {
        const deb = sectionOf(buildFactPack(REAL2, {model: m, style: 'debrief'}), 'THE RACE IN BRIEF');
        assert(deb.includes('18 started, 16 finished, 2 did not finish'), deb);
        assert(/The winner: [^,]+, in 29m 12s\./.test(deb), deb);
        assert(deb.includes('You: 8th of 16 finishers, in 29m 57s, 45.0 s behind the winner.'), deb);
        assert(/the last time each was in your group: 15:05 into the race \([^)]*Epic KOM Reverse/.test(deb), deb);
        assert(deb.includes('until 9:26 into the race, with 13.16 km to go'), deb);
        // The commentary's is the field's: the podium and how the front formed, and no "you".
        const com = sectionOf(buildFactPack(REAL2, {model: m, style: 'commentary'}), 'THE RACE IN BRIEF');
        assert(/The podium: 1st [^,]+, 29m 12s; 2nd [^,]+, 29m 13s; 3rd /.test(com), com);
        assert(/How the front of the race formed: the 7 riders who finished at the front went clear of the group behind them at 15:05/.test(com), com);
        assert(!/\byou\b|\byour\b/i.test(com.replace(/^.*\n.*\n/, '')), com);
    });

    check('17 Sep 2026: THE RIDER\'S TEAM finds team mates by tag, ignoring case, with their result', () => {
        const text = buildFactPack(REAL2, {model: m, style: 'commentary', teamTag: 'bcc'});
        const part = sectionOf(text, 'THE RIDER\'S TEAM');
        assert(/\[BCC\]: at the line in the group behind yours; last in your group at 28:10; officially 9th/.test(part), part);
        assert(part.includes('Other tags in this race: ') && part.includes('NZBRO'), part);
        const none = sectionOf(buildFactPack(REAL2, {model: m, style: 'commentary'}), 'THE RIDER\'S TEAM');
        assert(none.includes('team tag is not known. Tell the race of the whole field.'), none);
        const withheld = sectionOf(buildFactPack(REAL2, {model: m, style: 'commentary', teamTag: 'BCC', includeNames: false}), 'THE RIDER\'S TEAM');
        assert(withheld.includes('Team tags were left out with the names'), withheld);
    });
} else {
    console.log('  skip the real recording of 17 Sep 2026 (not found next to the mod)');
}

/* ================================================================= 8. storage without broadcasting */

section('8. storage: nothing is broadcast to Sauce\'s other windows, and long races keep every second');

/*
 * A localStorage that notes every write. In Sauce each of these would reach every other Sauce
 * window as a 'storage' event, and a "/" key would be JSON.parsed whole in every one of them
 * (pages/src/common.mjs:66-84).
 */
function spyStorage() {
    const storage = new MemoryStorage();
    storage.writes = [];
    storage.removes = [];
    const setItem = storage.setItem.bind(storage);
    const removeItem = storage.removeItem.bind(storage);
    storage.setItem = (k, v) => {
        storage.writes.push([k, String(v).length]);
        setItem(k, v);
    };
    storage.removeItem = k => {
        storage.removes.push(k);
        removeItem(k);
    };
    return storage;
}

function spySettings() {
    const settings = new MemoryAdapter();
    settings.writes = [];
    const set = settings.set.bind(settings);
    settings.set = (k, v) => {
        settings.writes.push(k);
        set(k, v);
    };
    return settings;
}

/*
 * A whole synthetic race, with the crash snapshot saved the way ui.mjs saves it: every
 * `every` seconds, from the data callback, without waiting for the write. Returns the finished
 * race and every save's promise.
 */
function recordWithSnapshots(store, {every = 20, ...opts} = {}) {
    const clock = new FakeClock();
    const finished = [];
    const saves = [];
    let lastSave = clock.now();
    const r = new Recorder({
        now: () => clock.now(),
        onFinalized: x => finished.push(x),
        onChange: rec => {
            if (rec.state === 'recording' && clock.now() - lastSave >= every * 1000) {
                lastSave = clock.now();
                saves.push(store.saveLive(rec.snapshotForCrash(), {rowsEpoch: rec.rowsEpoch}));
            }
        },
        ...opts,
    });
    runSyntheticRace(r, clock, opts);
    return {rec: finished[0], saves, recorder: r};
}

const THREE_HOURS = 3 * 3600;
const LONG_FEED = {seconds: THREE_HOURS, endDistance: 200000};

await checkAsync('IndexedDB is used when it works, and each saved race says which store kept it', async () => {
    const idb = new FakeIndexedDB();
    const store = await openStore({indexedDB: idb, localStorage: spyStorage()});
    assertEq(store.kind, 'indexeddb');
    assertEq(store.fallbackReason, null);
    const res = await store.save(RACE);
    assert(res.ok, res.error);
    assertEq((await store.load(RACE.id)).storedIn, 'indexeddb');
    assertEq(store.list()[0].storedIn, 'indexeddb');
    // The list and the races are still there for the next window.
    const again = await openStore({indexedDB: idb});
    assertEq(again.list().length, 1);
    assertEq((await again.load(RACE.id)).id, RACE.id);
    const local = localStore();
    await local.save(RACE);
    assertEq((await local.load(RACE.id)).storedIn, 'localstorage');
});

check('the IndexedDB budgets come from the storage estimate, with a fixed fallback', () => {
    const big = indexedDBBudgets({quota: 100e9, usage: 0});
    assertEq(big.total, 512_000_000);
    assertEq(big.perRace, 64_000_000);
    assertEq(big.source, 'estimate');
    const small = indexedDBBudgets({quota: 100_000_000});
    assertEq(small.total, 25_000_000);
    assertEq(small.perRace, 8_000_000);
    assert(small.warnAt < small.total);
    const tiny = indexedDBBudgets({quota: 20_000_000});
    assert(tiny.perRace <= tiny.total, 'one race may take more than the whole budget');
    for (const none of [null, {}, {quota: 0}, {quota: NaN}]) {
        const b = indexedDBBudgets(none);
        assertEq(b.source, 'fixed');
        assertEq(b.perRace, IDB_FIXED_BUDGETS.perRace);
        assertEq(b.total, IDB_FIXED_BUDGETS.total);
    }
});

await checkAsync('with IndexedDB missing, throwing or failing, the store falls back to localStorage under keys Sauce ignores', async () => {
    const cases = [
        ['missing', null],
        ['open throws', new FakeIndexedDB({throwOnOpen: true})],
        ['open fails', new FakeIndexedDB({failOpen: true})],
        ['writes fail', new FakeIndexedDB({failWrites: true})],
    ];
    for (const [what, idb] of cases) {
        const storage = spyStorage();
        const store = await openStore({indexedDB: idb, localStorage: storage});
        assertEq(store.kind, 'localstorage', what);
        assert(store.fallbackReason, `${what}: no reason given for the fallback`);
        assertEq(store.perRaceBudget, LOCAL_BUDGETS.perRace, what);
        const res = await store.save(RACE);
        assert(res.ok, `${what}: ${res.error}`);
        assertEq((await store.load(RACE.id)).storedIn, 'localstorage', what);
        const back = await localStore(storage).init();
        assertEq(back.list().length, 1, `${what}: the list did not survive`);
        for (const [k, n] of storage.writes) {
            assert(!k.startsWith('/'), `${what}: wrote ${k}, which every Sauce window would parse`);
            assert(n <= LOCAL_PIECE_CHARS, `${what}: one write was ${n} characters`);
        }
    }
    // No localStorage at all: memory, so the window still works, and it says so.
    const none = await openStore({indexedDB: null, localStorage: null});
    assertEq(none.kind, 'memory');
    assert((await none.save(RACE)).ok);
});

// Races as an earlier version saved them: whole, under "/" keys, through Common.storage.
function legacyStorageWith(races, {live = null, pending = null} = {}) {
    const storage = spyStorage();
    storage.setItem(KEY_INDEX, JSON.stringify(races.map(x => ({...summarize(x), bytes: JSON.stringify(x).length}))));
    for (const r of races) {
        storage.setItem(keyForRecording(r.id), JSON.stringify(r));
    }
    if (live) {
        storage.setItem(KEY_LIVE, JSON.stringify(live));
    }
    if (pending) {
        storage.setItem(KEY_PENDING, JSON.stringify(pending));
    }
    storage.setItem(LEGACY_KEY_SETTINGS, JSON.stringify({racesOnly: true}));
    storage.writes = [];
    return storage;
}

// An in-progress snapshot of the synthetic race, cut off `seconds` in.
function snapshotAt(seconds, opts = {}) {
    const clock = new FakeClock();
    let snap = null;
    const r = new Recorder({now: () => clock.now(), ...opts});
    runSyntheticRace({
        setScheduledStart: () => undefined,
        unnamedRiderIds: () => r.unnamedRiderIds(),
        setRiderName: (id, n) => r.setRiderName(id, n),
        onSelf: p => {
            if (!snap && r.rec && r.rec.timeline.t.length >= seconds) {
                snap = JSON.parse(JSON.stringify(r.snapshotForCrash()));
            }
            return snap ? 'ok' : r.onSelf(p);
        },
        onGroups: g => (snap ? undefined : r.onGroups(g)),
    }, clock, opts);
    return snap;
}

await checkAsync('races saved by an earlier version move into IndexedDB without losing any', async () => {
    const races = [RACE, {...RACE_120, id: 'rec-after-line'}, {...FULL, id: 'rec-full'}];
    const live = snapshotAt(400);
    const pending = {...snapshotAt(200), id: 'rec-pending'};
    const legacy = legacyStorageWith(races, {live, pending});
    const idb = new FakeIndexedDB();
    const store = await openStore({indexedDB: idb, legacy: new LegacyStorage(legacy)});
    assertEq(JSON.stringify(store.migration), JSON.stringify({moved: 3, kept: 0, snapshots: 2, waiting: 0}));
    assertEq(store.list().length, 3);
    for (const old of races) {
        const back = JSON.parse(await store.loadRaw(old.id));
        assertEq(back.storedIn, 'indexeddb');
        delete back.storedIn;
        assertEq(JSON.stringify(back), JSON.stringify(old), `${old.id} changed on the way`);
    }
    assertEq(JSON.stringify(await store.loadPending()), JSON.stringify(pending));
    assertEq(JSON.stringify(await store.loadLive()), JSON.stringify(live));
    // Nothing old is removed in the start that copied it: that start cannot tell whether the copy
    // survives Sauce closing.
    assertEq(await store.dropMovedCopies(), 0);
    assertEq(legacy.writes.length + legacy.removes.length, 0, 'the first start touched the old keys');
    for (const old of races) {
        assertEq(legacy.getItem(keyForRecording(old.id)), JSON.stringify(old), `${old.id} went too soon`);
    }
    // The next start finds its copies still there, copies nothing again, and removes the old
    // keys, all at once and only when asked (ui.mjs asks when no race is recording).
    const again = await openStore({indexedDB: idb, legacy: new LegacyStorage(legacy)});
    assertEq(JSON.stringify(again.migration), JSON.stringify({moved: 0, kept: 0, snapshots: 0, waiting: 5}));
    assertEq(again.list().length, 3);
    assertEq(legacy.removes.length, 0, 'the old keys were removed before ui.mjs asked');
    assertEq(await again.dropMovedCopies(), 5);
    for (const old of races) {
        assertEq(legacy.getItem(keyForRecording(old.id)), null, `${old.id} was left behind`);
    }
    for (const k of [KEY_INDEX, KEY_LIVE, KEY_PENDING]) {
        assertEq(legacy.getItem(k), null, `${k} was left behind`);
    }
    assertEq(legacy.writes.length, 0, 'moving the races out wrote to a "/" key');
    assertEq(legacy.removes.length, 6, 'removed more than the races, the snapshots and the index');
    assertEq(legacy.getItem(LEGACY_KEY_SETTINGS), JSON.stringify({racesOnly: true}), 'the settings were touched');
    // A third start has nothing to do, and the snapshot of the race that was running is offered.
    const third = await openStore({indexedDB: idb, legacy: new LegacyStorage(legacy)});
    assertEq(JSON.stringify(third.migration), JSON.stringify({moved: 0, kept: 0, snapshots: 0, waiting: 0}));
    assertEq(third.list().length, 3);
    assertEq((await third.takePending()).id, live.id);
    // ui.mjs asks for the removal only when nothing is recording and the rider is not in an event.
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/recorder\.state !== 'recording' &&\s*\(recorder\.lastSelfAt \? !lastSelfInEvent/.test(ui) &&
           ui.includes('store.dropMovedCopies()'), 'ui.mjs removes the old keys while a race may be running');
});

await checkAsync('an old race is only removed once its new copy reads back identically, and on a later start', async () => {
    const races = [RACE, {...RACE, id: 'rec-full-pool'}, {...RACE, id: 'rec-garbled'}];
    const legacy = legacyStorageWith(races);
    const kv = new LocalStorageKV(new MemoryStorage());
    const write = kv.update.bind(kv);
    kv.update = (key, fn) => write(key, raw => {
        const r = fn(raw);
        if ((r.puts || []).some(([k]) => k === 'race/rec-full-pool')) {
            throw new Error('QuotaExceededError');
        }
        return r;
    });
    const get = kv.get.bind(kv);
    kv.get = async k => {
        const v = await get(k);
        return k === 'race/rec-garbled' && v ? v.replace('"finish"', '"manual"') : v;
    };
    const store = await new Store(kv, new MemoryAdapter(), LOCAL_BUDGETS).init();
    const report = await store.migrateFrom(new LegacySource(new LegacyStorage(legacy)));
    assertEq(report.moved, 1);
    assertEq(report.kept, 2);
    assertEq(store.list().map(x => x.id).join(), RACE.id, 'a copy that did not read back was kept in the list');
    // A later start removes only the one that moved.
    const later = new Store(kv, new MemoryAdapter(), LOCAL_BUDGETS);
    await later.init();
    const again = await later.migrateFrom(new LegacySource(new LegacyStorage(legacy)));
    assertEq(again.waiting, 1);
    await later.dropMovedCopies();
    assertEq(legacy.getItem(keyForRecording(RACE.id)), null);
    assertEq(legacy.getItem(keyForRecording('rec-full-pool')), JSON.stringify(races[1]),
             'a race that did not fit was removed');
    assertEq(legacy.getItem(keyForRecording('rec-garbled')), JSON.stringify(races[2]),
             'a race that did not read back identically was removed');
    assertEq(JSON.parse(legacy.getItem(KEY_INDEX)).map(x => x.id).join(), `${RACE.id},rec-full-pool,rec-garbled`,
             'the old list was rewritten, which reloads Sauce\'s overlays');
});

await checkAsync('a database that did not keep its copies gets them again, and a race deleted in between does not come back', async () => {
    const races = [RACE, {...RACE, id: 'rec-2'}];
    const legacy = legacyStorageWith(races);
    // Start 1 copies both; start 2 is on a database that kept nothing (as if IndexedDB were not
    // kept on disk), so it copies them again and removes nothing.
    await openStore({indexedDB: new FakeIndexedDB(), legacy: new LegacyStorage(legacy)});
    const idb = new FakeIndexedDB();
    const second = await openStore({indexedDB: idb, legacy: new LegacyStorage(legacy)});
    assertEq(second.migration.moved, 2);
    assertEq(second.migration.waiting, 0);
    await second.dropMovedCopies();
    assertEq(legacy.removes.length, 0, 'old races were removed with no copy proven to survive');
    // The rider deletes one of them in that session. Start 3 removes both old copies, and the
    // deleted race stays deleted.
    await second.remove('rec-2');
    const third = await openStore({indexedDB: idb, legacy: new LegacyStorage(legacy)});
    await third.dropMovedCopies();
    assertEq(third.list().map(x => x.id).join(), RACE.id, 'a deleted race came back');
    assertEq(legacy.getItem(keyForRecording('rec-2')), null);
    assertEq(legacy.getItem(KEY_INDEX), null);
});

await checkAsync('races saved while IndexedDB would not open are listed again once it does', async () => {
    // A start where IndexedDB fails (here: the first start after upgrading, with old races under
    // "/" keys), then a start where it works.
    const storage = legacyStorageWith([RACE]);
    const idb = new FakeIndexedDB({failOpen: true});
    const first = await openStore({indexedDB: idb, localStorage: storage, legacy: new LegacyStorage(storage)});
    assertEq(first.kind, 'localstorage');
    assert(first.indexedDBFailed, 'the window is not told races may be missing');
    assertEq(first.list().map(x => x.id).join(), RACE.id, 'the old races are not listed in the fallback');
    assert((await first.save({...RACE, id: 'rec-fallback'})).ok);
    await first.saveLive({...RACE, id: 'rec-running', inProgress: true});
    idb.failOpen = false;
    const second = await openStore({indexedDB: idb, localStorage: storage, legacy: new LegacyStorage(storage)});
    assertEq(second.kind, 'indexeddb');
    assertEq(second.list().map(x => x.id).sort().join(), [RACE.id, 'rec-fallback'].sort().join(),
             'a race kept in the fallback is not listed');
    assertEq((await second.takePending()).id, 'rec-running', 'the snapshot kept in the fallback is not offered');
    await second.dropMovedCopies();
    // Start 3 finds the copies and clears the fallback and the old keys; a fourth lists the same.
    const third = await openStore({indexedDB: idb, localStorage: storage, legacy: new LegacyStorage(storage)});
    await third.dropMovedCopies();
    const left = [...storage.map.keys()].filter(k => k !== KEY_SETTINGS && k !== LEGACY_KEY_SETTINGS);
    assertEq(left.join(), '', 'the fallback or the old keys were left behind');
    const fourth = await openStore({indexedDB: idb, localStorage: storage, legacy: new LegacyStorage(storage)});
    assertEq(fourth.list().length, 2);
    assertEq((await fourth.loadPending()).id, 'rec-running');
});

await checkAsync('IndexedDB that is slow to open the first time is tried again before the fallback', async () => {
    const idb = new FakeIndexedDB({hangOpens: 1});
    const store = await openStore({indexedDB: idb, localStorage: new MemoryStorage(), openTimeoutMs: 20});
    assertEq(store.kind, 'indexeddb');
    const never = await openStore({indexedDB: new FakeIndexedDB({hangOpens: 2}), localStorage: new MemoryStorage(),
                                   openTimeoutMs: 20, retryTimeoutMs: 20});
    assertEq(never.kind, 'localstorage');
    assert(never.indexedDBFailed);
    assert(/in time/.test(never.fallbackReason), never.fallbackReason);
});

/*
 * A gun race as a list of what reaches the window, so it can be played back with the store's
 * writes landing between packets, as they do in Sauce, where the snapshot is saved 20 seconds
 * apart. `cut` is where Sauce restarts. See runGunRace in synthetic-feed.mjs.
 */
function gunRaceEvents(cut, feed) {
    const clock = {t: 0};
    const events = [];
    runGunRace({
        setScheduledStart: (id, ms) => events.push({t: clock.t, gun: [id, ms]}),
        onSelf: p => {
            events.push({t: clock.t, self: p});
            return 'ok';
        },
        onGroups: g => events.push({t: clock.t, groups: g}),
    }, clock, {...feed, onSecond: s => events.push({t: clock.t, second: s})});
    return events.filter(x => x.t - GUN_SERVER_MS <= cut * 1000);
}

await checkAsync('the crash snapshot is written as the rows added since the last save, and reads back whole', async () => {
    // Saved every 20 seconds the way ui.mjs does, while a gun race runs: a window that came up
    // before the scheduled start was known, so the recording starts on Zwift's clock and every
    // row is moved onto the gun at second 200; then the finish at 601, and the extra time after
    // the line. Each cut is where Sauce restarts; the next window must read back exactly the
    // snapshot that was last saved. Played once with every save landing before the next packet,
    // and once with none of them landing until the end.
    for (const cut of [150, 260, 640]) {
        for (const waitForSaves of [true, false]) {
            const what = `cut ${cut}${waitForSaves ? '' : ', saves queued'}`;
            const idb = new FakeIndexedDB();
            const store = await openStore({indexedDB: idb});
            const clock = new FakeClock();
            const r = new Recorder({now: () => clock.now(), gunClock: true, afterLineSeconds: 120});
            const chunks = [];
            const kvWrite = store.kv.write.bind(store.kv);
            store.kv.write = (puts, deletes) => {
                const head = puts.find(([k]) => k.endsWith('/head'));
                const paths = head ? JSON.parse(head[1]).__rows.paths : [];
                for (const [k, v] of puts) {
                    const m = k.match(/\/rows\/(\d+)$/);
                    if (m) {
                        const c = JSON.parse(v);
                        chunks.push([Number(m[1]), Object.fromEntries(paths.map((path, i) =>
                            [path, c.rows[i] || []]))]);
                    }
                }
                return kvWrite(puts, deletes);
            };
            const saves = [];
            let expected = null;
            for (const ev of gunRaceEvents(cut, {startLookupAt: 200, afterSeconds: 60})) {
                clock.t = ev.t;
                if (ev.gun) {
                    r.setScheduledStart(...ev.gun);
                } else if (ev.self) {
                    r.onSelf(ev.self);
                } else if (ev.groups) {
                    r.onGroups(ev.groups);
                } else if (ev.second % 20 === 0 && r.state === 'recording') {
                    const snap = r.snapshotForCrash();
                    expected = JSON.stringify(snap);
                    const save = store.saveLive(snap, {rowsEpoch: r.rowsEpoch});
                    saves.push(waitForSaves ? await save : save);
                }
            }
            const landed = await Promise.all(saves);
            assert(expected, `${what}: nothing was saved`);
            assert(landed[landed.length - 1], `${what}: the last save failed`);
            // Sauce restarts: a new window, a new store on the same database.
            const back = await (await openStore({indexedDB: idb})).takePending();
            assertEq(JSON.stringify(back), expected, `${what}: the snapshot did not read back whole`);
            if (cut === 260) {
                assertEq(back.gunSource, 'scheduled-start', 'the move onto the gun did not reach the snapshot');
            }
            if (cut === 640) {
                assert(back.afterLine && back.afterLine.timeline.t.length > 0, 'no extra time in the snapshot');
                assertEq(back.timeline.t[back.timeline.t.length - 1], 600,
                         'the race in the snapshot runs past the line');
            }
            if (!waitForSaves) {
                continue;
            }
            // Past the first save, a save writes only the rows added in the 20 seconds since the
            // one before, apart from the save straight after the move onto the gun, which starts
            // again from chunk 0 because every row it had written changed.
            assert(landed.every(Boolean), `${what}: a save failed`);
            assertEq(chunks.length, saves.length, `${what}: not one chunk per save`);
            const starts = chunks.filter(([n]) => n === 0).length;
            assertEq(starts, cut >= 200 ? 2 : 1, `${what}: the snapshot started again ${starts} times`);
            for (const [n, c] of chunks.filter(([n]) => n > 0)) {
                const rows = (c['timeline.t'] || []).length + (c['afterLine.timeline.t'] || []).length;
                assert(rows <= 21, `${what}: chunk ${n} holds ${rows} seconds of rows`);
            }
            assert(chunks.filter(([n]) => n === 0).every(([, c]) => c['timeline.t'].length > 0),
                   `${what}: the chunks were not read the way they are written`);
        }
    }
});

await checkAsync('a resumed snapshot saves as a race, through the same steps ui.mjs takes', async () => {
    const store = await openStore({indexedDB: new FakeIndexedDB()});
    const open = recordSynthetic({afterSeconds: 40, afterLineSeconds: 120});
    await store.saveLive(open.recorder.snapshotForCrash(), {rowsEpoch: open.recorder.rowsEpoch});
    const live = await (await openStore({indexedDB: store.kv.factory})).takePending();
    const rec = {...live};
    delete rec.inProgress;
    rec.endedAt = live.snapshotAt;
    rec.endedISO = new Date(rec.endedAt).toISOString();
    assert((await store.save(rec)).ok);
    await store.clearPending();
    assertEq(await store.loadPending(), null);
    const saved = await store.load(rec.id);
    assertEq(saved.afterLine.endedBy, 'window-closed');
    assertEq(JSON.stringify(saved.timeline), JSON.stringify(RACE_120.timeline));
});

check('a snapshot taken apart and joined again is the same JSON, key for key', () => {
    const snap = recordSynthetic({afterSeconds: 40, afterLineSeconds: 120}).recorder.snapshotForCrash();
    const {head, rows} = splitSnapshot(snap);
    assert(!JSON.stringify(head).includes('"t":['), 'rows were left in the head');
    const counts = {};
    const a = {};
    const b = {};
    for (const [p, arr] of Object.entries(rows)) {
        counts[p] = arr.length;
        a[p] = arr.slice(0, 7);
        b[p] = arr.slice(7);
    }
    assertEq(JSON.stringify(joinSnapshot({...head, __rows: {counts, chunks: 2}}, [a, b])),
             JSON.stringify(snap));
});

const LONG_IDB = new FakeIndexedDB();
const LONG_STORE = await openStore({indexedDB: LONG_IDB, localStorage: spyStorage(),
                                    settings: spySettings()});
const LONG = recordWithSnapshots(LONG_STORE, {...LONG_FEED, sizeGuard: false,
                                              sizeBudgetBytes: LONG_STORE.perRaceBudget});
const LONG_SAVES = await Promise.all(LONG.saves);

await checkAsync('with IndexedDB a three hour race keeps every second of the rider and every two seconds of the pack', async () => {
    const rec = LONG.rec;
    assert(rec, 'the race did not finish');
    assertEq(rec.stopReason, 'finish');
    assertEq(rec.degraded.selfRowInterval, 1, 'the rider\'s own rows were thinned');
    assertEq(rec.degraded.packRowInterval, 2, 'the pack rows were thinned');
    assertEq(rec.counts.selfRows, THREE_HOURS);
    assert(Math.abs(rec.counts.packRows - THREE_HOURS / 2) <= 1, `packRows was ${rec.counts.packRows}`);
    assert(!rec.notes.some(x => x.includes('every five')), 'a note says the race was thinned');
    assertEq(rec.coverage.missingSeconds, 0);
    assertEq(rec.coverage.secondsRecorded, THREE_HOURS);
    assert(LONG_SAVES.length > 500 && LONG_SAVES.every(Boolean), 'the snapshots were not all written');
    const res = await LONG_STORE.save(rec);
    assert(res.ok, res.error);
    assert(res.entry.bytes > 400_000, `a three hour race is only ${res.entry.bytes} bytes`);
    assert(res.entry.bytes < LONG_STORE.perRaceBudget, 'a three hour race does not fit one race\'s budget');
    await LONG_STORE.clearLive(rec.id);
    const raw = await LONG_STORE.loadRaw(rec.id);
    const back = JSON.parse(raw);
    delete back.storedIn;
    assertEq(JSON.stringify(back), JSON.stringify(rec), 'the race did not read back as it was saved');
    // What "Save this race to a file" hands over is the stored text itself.
    assertEq(raw, res.json);
    const leftovers = [...LONG_IDB.dump(DB_NAME).keys()].filter(k => k.startsWith('snap/'));
    assertEq(leftovers.length, 0, `the snapshot was left behind: ${leftovers.length} keys`);
});

await checkAsync('while a long race records with IndexedDB, nothing at all is written to localStorage', async () => {
    const storage = spyStorage();
    const settings = spySettings();
    const store = await openStore({indexedDB: new FakeIndexedDB(), localStorage: storage, settings});
    const {rec, saves} = recordWithSnapshots(store, {seconds: 3600, endDistance: 200000, sizeGuard: false});
    assert((await Promise.all(saves)).every(Boolean));
    await store.save(rec);
    await store.clearLive(rec.id);
    assertEq(storage.writes.length, 0, `localStorage was written: ${storage.writes.slice(0, 3)}`);
    assertEq(settings.writes.length, 0, `the settings were written: ${settings.writes.slice(0, 3)}`);
});

await checkAsync('with the localStorage fallback no write while recording is over a few kB, and none is under "/"', async () => {
    const storage = spyStorage();
    const settings = spySettings();
    const store = await openStore({indexedDB: new FakeIndexedDB({throwOnOpen: true}),
                                   localStorage: storage, settings});
    assertEq(store.kind, 'localstorage');
    // As ui.mjs runs it there: the size ladder on, and the snapshot every minute.
    const {rec, saves} = recordWithSnapshots(store, {...LONG_FEED, every: 60,
                                                     sizeBudgetBytes: store.perRaceBudget});
    assert((await Promise.all(saves)).every(Boolean), 'a snapshot was not written');
    assertEq(rec.degraded.selfRowInterval, 5, 'the size ladder did not run in the fallback');
    const whole = JSON.stringify(rec).length;
    assert(storage.writes.length > 0);
    for (const [k, n] of storage.writes) {
        assert(!k.startsWith('/'), `wrote ${k} while recording`);
        assert(n <= LOCAL_PIECE_CHARS, `one write while recording was ${n} characters`);
    }
    assertEq(settings.writes.length, 0);
    // And a snapshot rewrites only a little: on average a save writes a small fraction of what
    // rewriting the whole recording once a minute would.
    const perSave = storage.writes.reduce((n, [, len]) => n + len, 0) / saves.length;
    assert(perSave < whole / 20, `a snapshot save wrote ${Math.round(perSave)} characters on average`);
    // And the pieces take little more of the shared pool than the snapshot as one value would.
    const snapshot = JSON.stringify(await store.loadLive()).length;
    const pieces = [...storage.map].filter(([k]) => k.includes('snap/')).reduce((n, [k, v]) => n + k.length + v.length, 0);
    assert(pieces < snapshot * 1.2, `the snapshot takes ${pieces} characters in pieces, ${snapshot} whole`);
    assertEq((await store.save(rec, {dropSnapshot: true})).ok, true);
    assertEq([...storage.map.keys()].filter(k => k.includes('snap/')).length, 0, 'the snapshot was left behind');
});

check('both copied texts and the file download work for a three hour race', () => {
    // Two minute rows past 40 minutes, and never more than 40 rows: five minutes for three hours.
    for (const style of ['commentary', 'debrief']) {
        const t0 = Date.now();
        const model = buildReport(LONG.rec, {});
        const text = buildFactPack(LONG.rec, {model, style});
        const ms = Date.now() - t0;
        assert(ms < 10000, `the report and the ${style} took ${ms} ms`);
        // One title whatever the step, which is what both prompts point at.
        assert(text.includes('=== MINUTE BY MINUTE (one row every 5 minutes) ==='), `${style}: the heading does not match the rows`);
        assert(text.includes('One row every 5 minutes. A dash means nothing was recorded.'));
        const rows = text.split('\n').filter(x => /^\d+:\d\d-\d+:\d\d \| /.test(x));
        assert(rows.length === 36, `${style}: ${rows.length} overview rows for three hours`);
        assert(text.includes(`Seconds recorded: ${THREE_HOURS} of the ${THREE_HOURS}`), 'coverage line wrong');
        // Within the hard cap, and well inside what a chat box takes (22 Sep 2026: 45 kB).
        assert(text.length < 45_000, `the ${style} is ${text.length} characters`);
    }
});

check('the overview heading says minute by minute when the rows are a minute apart', () => {
    for (const text of [factPack, debriefPack]) {
        assert(text.includes('=== MINUTE BY MINUTE ==='));
        assert(text.includes('One row every minute.'));
        const rows = text.split('\n').filter(x => /^\d+:\d\d-\d+:\d\d \| /.test(x));
        assertEq(rows.length, 25, 'rows for 25 minutes');
    }
});

check('each fact appears once in the fact pack\'s notes', () => {
    // As on Van's 69 minute session of 16 Sep 2026: a race long enough for the size ladder, started
    // by hand, and not complete.
    const {finished} = recordSynthetic({seconds: 5400, sizeBudgetBytes: 120000});
    const manual = new Recorder();
    manual.startManual();
    const rec = {...finished[0], trigger: 'manual', incomplete: true,
                 incompleteReasons: ['it was stopped by hand rather than at a finish line'],
                 notes: [...manual.rec.notes, ...finished[0].notes]};
    const text = buildFactPack(rec, {});
    const count = re => text.split('\n').filter(x => re.test(x)).length;
    assertEq(count(/group around you/), 1, 'the pack sampling note');
    assertEq(count(/own numbers (dropped|were recorded)/), 1, 'the rider\'s sampling note');
    assertEq(count(/started by hand/i), 1, 'the started by hand note');
    assertEq(count(/not a complete record/i), 1, 'the not a complete record note');
    // The window's own report is not changed here.
    assert(buildReport(rec, {}).notes.length > 4);
});

check('coverage counts each row at the interval it was recorded at, so gaps are not hidden', () => {
    // One second rows to row 99, then every five seconds, with a 23 second gap among them.
    const t = [];
    for (let s = 0; s < 100; s++) {
        t.push(s);
    }
    for (let s = 104; s <= 300; s += 5) {
        t.push(s);
    }
    for (let s = 322; s <= 500; s += 5) {
        t.push(s);
    }
    const rec = {timeline: {t}, degraded: {selfRowInterval: 5, selfRowIntervals: [[0, 1], [99, 5]]}};
    const c = computeCoverage(rec);
    assertEq(c.spanSeconds, 498);
    assertEq(c.largestGapSeconds, 23);
    assertEq(c.missingSeconds, 18, 'a 23 second gap in five second rows is 18 seconds missing');
    assertEq(c.secondsRecorded, 480);
    // Before the steps were kept only the final interval is known; one second rows still count one.
    assertEq(computeCoverage({timeline: {t}, degraded: {selfRowInterval: 5}}).missingSeconds, 18);
    // A gap in the one second rows before the step, which counting every row at five hid.
    const early = [...t.slice(0, 40), ...t.slice(62)];
    const e = computeCoverage({timeline: {t: early},
                               degraded: {selfRowInterval: 5, selfRowIntervals: [[0, 1], [77, 5]]}});
    assertEq(e.missingSeconds, 18 + 22);
    assertEq(e.largestGapSeconds, 23);
    // A race that stepped down the ladder with no gaps is whole.
    const {finished} = recordSynthetic({seconds: 5400, sizeBudgetBytes: 120000});
    const ladder = finished[0].coverage;
    assertEq(finished[0].degraded.selfRowIntervals.length, 2);
    assertEq(ladder.missingSeconds, 0);
    assertEq(ladder.secondsRecorded, ladder.spanSeconds);
    assert(ladder.rowsRecorded < ladder.spanSeconds * 0.75, 'the ladder never thinned the rows');
});


await checkAsync('a race that cannot be saved keeps its crash snapshot, and the next start offers it', async () => {
    // A one hour race whose snapshot fits, and then a disk with no room for the race (made bigger
    // than the snapshot here, as Sauce's stats and streams make it).
    const {rec: ridden, saves} = recordWithSnapshots(await openStore({indexedDB: new FakeIndexedDB()}),
                                                     {seconds: 3600, endDistance: 200000, sizeGuard: false});
    const rec = {...ridden, streams: {power: Array.from({length: 300000}, (_, i) => i % 400)}};
    for (const withIndexedDB of [true, false]) {
        const what = withIndexedDB ? 'IndexedDB' : 'fallback';
        const idb = new FakeIndexedDB();
        const storage = new MemoryStorage();
        const store = withIndexedDB ? await openStore({indexedDB: idb}) :
            new Store(new LocalStorageKV(storage), new MemoryAdapter(), {...LOCAL_BUDGETS, perRace: 1e9});
        const snap = {...ridden, inProgress: true, snapshotAt: rec.endedAt};
        assert(await store.saveLive(snap), `${what}: the snapshot was not written`);
        const used = withIndexedDB ? [...idb.dump(DB_NAME)].reduce((n, [k, v]) => n + k.length + v.length, 0) :
            storage._size();
        const room = 3 * JSON.stringify(RACE).length;
        assert(JSON.stringify(rec).length > JSON.stringify(ridden).length + room);
        if (withIndexedDB) {
            idb.limit = used + room;
        } else {
            storage.limit = used + room;
        }
        // What ui.mjs does at the finish.
        const res = await store.save(rec, {dropSnapshot: true});
        assertEq(res.ok, false, `${what}: the race fitted after all`);
        await store.keepUnsaved(rec.id);
        assertEq(await store.load(rec.id), null);
        // A new recording starts in the same session and is saved; the unsaved snapshot stays.
        assert(await store.saveLive({...RACE, id: 'rec-next', inProgress: true}));
        await store.clearLive('rec-next');
        idb.limit = Infinity;
        storage.limit = Infinity;
        const next = withIndexedDB ? await openStore({indexedDB: idb}) :
            await new Store(new LocalStorageKV(storage), new MemoryAdapter(), LOCAL_BUDGETS).init();
        const offered = await next.takePending();
        assert(offered, `${what}: the snapshot of the race that could not be saved is gone`);
        assertEq(offered.id, rec.id);
        assertEq(offered.counts.selfRows, 3600);
    }
    assert(saves.length > 0);
    // ui.mjs removes the snapshot only with the race, and keeps it when the save fails.
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(ui.includes('store.save(rec, {dropSnapshot: !stillRecording})') &&
           ui.includes('store.save(race, {dropSnapshot: true})'), 'ui.mjs does not save the snapshot with the race');
    assertEq((ui.match(/store\.keepUnsaved\(/g) || []).length, 2, 'ui.mjs does not keep the snapshot of a failed save');
    assert(/if \(res\.ok\) \{\s*\/\/[^\n]*\n\s*await store\.clearPending\(\)/.test(ui),
           'resuming clears the snapshot even when the save failed');
});

await checkAsync('a second Race Report window neither truncates the other\'s snapshot nor drops its race from the list', async () => {
    const idb = new FakeIndexedDB();
    const one = await openStore({indexedDB: idb});
    const two = await openStore({indexedDB: idb});
    const clock = new FakeClock();
    const r1 = new Recorder({now: () => clock.now()});
    const r2 = new Recorder({now: () => clock.now()});
    // The saves both windows make, in order, each landing before the next packet as it does 20
    // seconds apart in Sauce.
    const saves = [];
    runSyntheticRace({
        setScheduledStart: () => undefined,
        unnamedRiderIds: () => [],
        setRiderName: () => undefined,
        onSelf: p => {
            r2.onSelf(p);
            const res = r1.onSelf(p);
            const t = r1.state === 'recording' ? r1.rec.timeline.t.length : 0;
            if (t && t % 20 === 0 && t <= 640 && (!saves.length || saves[saves.length - 1].t !== t)) {
                if (t === 400) {
                    // The second window saves for the first time, with its own recording.
                    saves.push({t, store: two, epoch: r2.rowsEpoch,
                                snap: JSON.parse(JSON.stringify({...r2.snapshotForCrash(), id: 'rec-window-two'}))});
                }
                saves.push({t, store: one, epoch: r1.rowsEpoch, snap: JSON.parse(JSON.stringify(r1.snapshotForCrash()))});
            }
            return res;
        },
        onGroups: g => {
            r2.onGroups(g);
            return r1.onGroups(g);
        },
    }, clock, {});
    for (const x of saves) {
        assert(await x.store.saveLive(x.snap, {rowsEpoch: x.epoch}), `the save at ${x.t} failed`);
    }
    const expected = JSON.stringify(saves[saves.length - 1].snap);
    assertEq(saves[saves.length - 1].t, 640);
    const id = JSON.parse(expected).id;
    const reader = await openStore({indexedDB: idb});
    assertEq(JSON.stringify(await reader._serial(() => reader._readSnapshot(id))), expected,
             'the first window\'s snapshot does not read back whole');
    const keys = [...idb.dump(DB_NAME).keys()];
    assert(keys.some(k => k.startsWith('snap/rec-window-two/')), 'the second window\'s snapshot is gone');
    // A snapshot with a chunk missing is not offered as if it were whole.
    const kv = idb.databases.get(DB_NAME).stores.get('kv');
    const chunk = JSON.parse(kv.get(`snap/${id}/rows/1`));
    chunk.rows = chunk.rows.map(x => x.slice(1));
    kv.set(`snap/${id}/rows/1`, JSON.stringify(chunk));
    assertEq(await reader._serial(() => reader._readSnapshot(id)), null, 'a snapshot with rows missing was offered');
    kv.delete(`snap/${id}/rows/1`);
    assertEq(await reader._serial(() => reader._readSnapshot(id)), null, 'a snapshot with a chunk missing was offered');
    // Both windows save a race at the same moment: both stay in the list.
    await Promise.all([one.save({...RACE, id: 'rec-one'}), two.save({...RACE, id: 'rec-two'})]);
    const after = await openStore({indexedDB: idb});
    assertEq(after.list().map(x => x.id).sort().join(), 'rec-one,rec-two', 'one window dropped the other\'s race');
});

await checkAsync('an index that does not read back is rebuilt from the races, so no race drops out of the list', async () => {
    const storage = new MemoryStorage();
    const store = localStore(storage);
    for (let i = 0; i < 12; i++) {
        assert((await store.save({...RACE, id: `rec-${i}`})).ok);
    }
    // Sauce is killed part way through writing the index: a piece written, the count not.
    const count = Number(storage.getItem(`${LOCAL_PREFIX}index`));
    assert(count >= 1);
    storage.setItem(`${LOCAL_PREFIX}index#0`, storage.getItem(`${LOCAL_PREFIX}index#0`).slice(0, 100));
    const next = await localStore(storage).init();
    assertEq(next.list().length, 12, 'races dropped out of a list that did not read back');
    assert(next.indexRebuilt);
    assert((await next.save({...RACE, id: 'rec-next'})).ok);
    assertEq((await localStore(storage).init()).list().length, 13);
    // A store that cannot be read at all refuses to write an index over what it never saw.
    const broken = localStore(storage);
    broken.kv.get = async () => {
        throw new Error('unreadable');
    };
    assertEq((await broken.save({...RACE, id: 'rec-lost'})).ok, false);
    assertEq((await localStore(storage).init()).list().length, 13);
});

await checkAsync('the snapshot head stays small in a big field: riders are written when they change', async () => {
    // A three hour race in a field that keeps turning over: 40 new riders a minute, each in the
    // rider's group for a while. Before, the whole roster was rewritten in the head on every save.
    for (const withIndexedDB of [true, false]) {
        const storage = spyStorage();
        const idb = new FakeIndexedDB();
        const store = withIndexedDB ? await openStore({indexedDB: idb}) :
            await openStore({indexedDB: null, localStorage: storage});
        const heads = [];
        const chunks = [];
        const write = store.kv.write.bind(store.kv);
        store.kv.write = (puts, deletes) => {
            for (const [k, v] of puts) {
                (k.endsWith('/head') ? heads : (k.includes('/rows/') || k.includes('/riders/')) ? chunks : [])
                    .push(v.length);
            }
            return write(puts, deletes);
        };
        const riders = {};
        let expected = null;
        const every = withIndexedDB ? 20 : 60;
        for (let t = every; t <= THREE_HOURS; t += every) {
            for (let i = 0; i < 40 * every / 60; i++) {
                const n = Object.keys(riders).length;
                riders[String(10000 + n)] = {athleteId: 10000 + n, label: null, name: `Rider ${n}`,
                                             firstT: t, lastT: t, withMe: [[t, t]]};
            }
            for (const k of Object.keys(riders).slice(-60)) {
                riders[k].lastT = t;
                riders[k].withMe[riders[k].withMe.length - 1][1] = t;
            }
            const snap = {id: 'rec-big', inProgress: true, snapshotAt: t, counts: {selfRows: t},
                          timeline: {t: Array.from({length: t}, (_, i) => i)},
                          riders: JSON.parse(JSON.stringify(riders)), notes: []};
            assert(await store.saveLive(snap, {rowsEpoch: 0}));
            expected = JSON.stringify(snap);
        }
        const what = withIndexedDB ? 'IndexedDB' : 'fallback';
        assertEq(JSON.stringify(await store.loadLive()), expected, `${what}: the snapshot did not read back whole`);
        const roster = JSON.stringify(riders).length;
        assert(roster > 400_000, `the roster is only ${roster} characters`);
        const lastHead = heads[heads.length - 1];
        assert(lastHead < roster / 5, `${what}: the head is ${lastHead} characters for a roster of ${roster}`);
        // Before, every save rewrote the whole roster; now a save writes the riders that changed,
        // and now and then all of them once, when the changed ones add up to twice the roster.
        const saves = THREE_HOURS / every;
        const perSave = chunks.reduce((a, b) => a + b, 0) / saves;
        assert(perSave < roster / 10, `${what}: a save writes ${Math.round(perSave)} characters of rows and riders`);
        const stored = withIndexedDB ?
            [...idb.dump(DB_NAME)].filter(([k]) => k.startsWith('snap/')).reduce((n, [, v]) => n + v.length, 0) :
            [...storage.map].filter(([k]) => k.includes('snap/')).reduce((n, [k, v]) => n + k.length + v.length, 0);
        assert(stored < expected.length * 3.5, `${what}: the snapshot takes ${stored} characters, ` +
               `${(stored / expected.length).toFixed(2)} times the snapshot itself`);
        if (!withIndexedDB) {
            for (const [k, n] of storage.writes) {
                assert(!k.startsWith('/') && n <= LOCAL_PIECE_CHARS, `${what}: wrote ${n} characters under ${k}`);
            }
        }
    }
    // The size guard counts the riders too, so the fallback's ladder sees a big field.
    const clock = new FakeClock();
    const a = new Recorder({now: () => clock.now()});
    const b = new Recorder({now: () => clock.now()});
    for (let t = 1; t <= 50; t++) {
        clock.t += 1000;
        const self = makeSelfPayload({
            t, stateTime: t, eventSubgroupId: 999, power: 260, hr: 165, cadence: 88, speed: 42,
            draft: 40, distance: t * 11, eventDistance: t * 11, grade: 0.01, wBal: 17000,
            eventPosition: 12, eventParticipants: 46, activePowerUp: null,
            endDistance: SYNTHETIC_END_DISTANCE,
        });
        a.onSelf(self);
        b.onSelf(self);
        a.onGroups(makeGroupsPayload({myGroup: {ids: [SELF_ID, 2001], power: 280, draft: 50, hr: 168,
                                                speed: 42, gap: 0, id: 1}}));
        b.onGroups(makeGroupsPayload({myGroup: {ids: [SELF_ID, ...Array.from({length: 40}, (_, i) => 3000 + t * 40 + i)],
                                                power: 280, draft: 50, hr: 168, speed: 42, gap: 0, id: 1}}));
    }
    // The pack is taken every two seconds, so 25 of those payloads, 40 new riders each.
    assert(a.state === 'recording' && b.rec.counts.riders >= 1000, 'the riders were not recorded');
    assert(b.approxBytes() - a.approxBytes() > 1000 * 80, 'the size guard does not count the riders');
});

await checkAsync('a snapshot nothing points at any more is cleared at startup, but not one still being written', async () => {
    let now = 1_800_000_000_000;
    const idb = new FakeIndexedDB();
    const store = await openStore({indexedDB: idb, now: () => now});
    await store.saveLive({...RACE, id: 'rec-orphan', inProgress: true});
    // Its window closed without cleaning up, and eleven minutes later another window took the
    // live slot. A minute after that a third window took it, while the second still records.
    now += 11 * 60 * 1000;
    await store.saveLive({...RACE, id: 'rec-second-window', inProgress: true});
    now += 60_000;
    const third = await openStore({indexedDB: idb, now: () => now});
    await third.saveLive({...RACE, id: 'rec-third-window', inProgress: true});
    await openStore({indexedDB: idb, now: () => now + 1000});
    const snaps = new Set([...idb.dump(DB_NAME).keys()].filter(k => k.startsWith('snap/')).map(k => k.split('/')[1]));
    assert(!snaps.has('rec-orphan'), 'the orphan was kept');
    assert(snaps.has('rec-second-window'), 'a snapshot saved a minute ago was cleared');
    assert(snaps.has('rec-third-window'), 'the snapshot in the live slot was cleared');
});

await checkAsync('a race deleted during the extra time after the line is not saved again when it ends', async () => {
    const store = await openStore({indexedDB: new FakeIndexedDB()});
    assert((await store.save(RACE_120)).ok);
    await store.remove(RACE_120.id);
    assert(store.wasRemoved(RACE_120.id));
    assert(!store.wasRemoved('rec-other'));
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    const fin = ui.match(/async function onFinalized[\s\S]*?\n\}/)[0];
    assert(fin.indexOf('store.wasRemoved(rec.id)') !== -1 &&
           fin.indexOf('store.wasRemoved(rec.id)') < fin.indexOf('store.save('),
           'onFinalized saves a race the rider deleted');
});

check('the scheduled start is not looked up while no recording could use it', () => {
    const r = new Recorder({gunClock: true});
    assert(r.wantsScheduledStart(999), 'nothing recording, and the next race may count from it');
    r.startManual();
    assert(!r.wantsScheduledStart(999), 'a hand-started recording never counts from a scheduled start');
    const c = new FakeClock();
    const g = new Recorder({now: () => c.now(), gunClock: true});
    let onZwiftClock = null;
    let onGun = null;
    runGunRace(g, c, {seconds: 100, onSecond: s => {
        if (s === 30) {
            onZwiftClock = g.wantsScheduledStart(999);
        }
    }, startLookupAt: 1e9});
    const h = new Recorder({now: () => c.now(), gunClock: true});
    runGunRace(h, c, {seconds: 100, onSecond: s => {
        if (s === 30) {
            onGun = h.wantsScheduledStart(999);
        }
    }});
    assertEq(onZwiftClock, true, 'a recording on Zwift\'s clock could still be moved onto the gun');
    assertEq(onGun, false, 'a recording already on the gun keeps it');
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(ui.includes('!recorder.wantsScheduledStart(id)'), 'ui.mjs asks regardless');
});


check('no em-dash in any text the rider can see', () => {
    for (const f of ['src/recorder.mjs', 'src/ui.mjs', 'src/report.mjs', 'src/factpack.mjs', 'src/store.mjs',
                     'race-report.html', 'README.md']) {
        const s = FS.readFileSync(Path.join(MOD_DIR, f), 'utf8');
        assert(!s.includes('—'), `${f} contains an em-dash`);
    }
});



/* ================================================================= 9. the two copied texts */

section('9. race commentary and coach\'s debrief: the membership log, the flicker, and the two texts');

const styles = ['commentary', 'debrief'];
const packOf = (rec, style, opts = {}) => buildFactPack(rec, {model: buildReport(rec, {}), style, ...opts});
const partOf = (text, head) => {
    const m = text.match(new RegExp(`=== ${head} ===[\\s\\S]*?(?=\\n\\n===|$)`));
    return m ? m[0] : '';
};

check('the recorder logs who went clear, by per-race number, never by athlete id', () => {
    const m = RACE.moves;
    assert(m && Array.isArray(m.t), 'no membership log');
    assertEq(m.t.length, m.rider.length);
    const keyOf = new Map(Object.entries(RACE.riders).map(([k, r]) => [r.seq, k]));
    const clear = m.t.map((t, i) => [t, keyOf.get(m.rider[i]), m.from[i], m.to[i]]).filter(x => x[2] === 0 && x[3] === -1);
    assertEq(clear.map(x => x[1]).sort().join(','), '2001,2002,2003,Rider A', JSON.stringify(clear));
    for (const [t] of clear) {
        assert(t >= 619 && t <= 623, `the move is logged at ${t}, not when it began`);
    }
    // Every rider's first entry is from out of view; the group behind never moved.
    const firsts = new Set();
    m.rider.forEach((seq, i) => {
        if (!firsts.has(seq)) {
            firsts.add(seq);
            assertEq(m.from[i], null, 'a first entry that is not from out of view');
        }
    });
    assert(!JSON.stringify(m).includes('5005'), 'the unnamed rider\'s id is in the log');
    assertEq(new Set(Object.values(RACE.riders).map(r => r.seq)).size, Object.keys(RACE.riders).length,
             'two riders share a sequence number');
});

// A 65 minute race in a field of 80 whose grouping flickers (runLongRace in synthetic-feed.mjs),
// saved as IndexedDB saves it, with no size ladder.
function recordLong(opts = {}) {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), afterLineSeconds: 120,
                            sizeGuard: false, ...opts});
    runLongRace(r, clock, opts);
    const rec = finished[0];
    const endDistance = rec.timeline.eventDistance.filter(x => x != null).pop();
    return {...rec, event: makeLongEventInfo(endDistance), segments: LONG_RACE_SEGMENTS,
            self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5},
            stats: makeLongRaceStats(3900),
            sauce: {version: '2.3.3'}};
}
const BIG = recordLong();

check('the big field really flickers: one payload shows the rider\'s group of 81 as 10', () => {
    const p = BIG.pack;
    const cut = p.t.filter((t, i) => p.myGroupSize[i] === 10 && t < 1300);
    assert(cut.length >= 3, `only ${cut.length} flickered rows before the split`);
    // And without the hold, findSplits would take those rows for splits.
    const raw = findSplits(p, {hold: 0});
    assert(raw.some(x => x.after === 10), `with no hold no flicker split was found: ${JSON.stringify(raw)}`);
});

check('in a flickering big field the membership log holds only the moves that happened', () => {
    const m = BIG.moves;
    const keyOf = new Map(Object.entries(BIG.riders).map(([k, r]) => [r.seq, k]));
    const seen = new Set();
    const moves = [];
    m.t.forEach((t, i) => {
        if (seen.has(m.rider[i])) {
            moves.push([t, keyOf.get(m.rider[i]), m.from[i], m.to[i]]);
        }
        seen.add(m.rider[i]);
    });
    // The script: 5:00 three clear, 15:00 caught, 21:40 twenty clear, 22:00 six dropped, 43:20 three
    // back, 50:00 five clear (the twenty become a group further up), 60:40 ten dropped (the six
    // become a group further back).
    const scripted = [300, 900, 1300, 1320, 2600, 3000, 3640];
    for (const [t, key, from, to] of moves) {
        assert(scripted.some(x => t >= x && t <= x + 2), `a move nobody made: ${key} ${from} -> ${to} at ${fmtClock(t)}`);
    }
    assertEq(moves.length, 3 + 3 + 20 + 6 + 3 + 5 + 17 + 10 + 6, 'the number of moves');
    // Riders who never left the rider's group have their first entry and nothing else.
    for (let id = 4026; id <= 4060; id++) {
        assert(!moves.some(x => x[1] === String(id)), `rider ${id} is logged moving`);
    }
});

check('a split must hold: the flicker is no split, and nobody leaves twice or leaves and stays', () => {
    const splits = findSplits(BIG.pack);
    assertEq(splits.length, 1, JSON.stringify(splits));
    assert(splits[0].t1 >= 1300 && splits[0].t0 <= 1320, JSON.stringify(splits[0]));
    assert(splits[0].before >= 70 && splits[0].after <= 60, JSON.stringify(splits[0]));
    const left = ridersWhoLeft(BIG.riders, splits[0].t0, splits[0].t1);
    const ids = left.map(x => Number(x.id));
    assertEq(new Set(ids).size, ids.length, 'a rider is listed twice');
    for (const id of ids) {
        assert((id >= 4001 && id <= 4020) || (id >= 4071 && id <= 4076), `rider ${id} did not leave`);
    }
    assert(SPLIT_HOLD_SECONDS >= 10 && MOVE_HOLD_SECONDS === 5);
    for (const style of styles) {
        const text = packOf(BIG, style);
        assert(!/from \d+ to 10 riders/.test(text), `${style}: a flicker split reached the text`);
        assert(!/Racer 40(2[6-9]|[3-5]\d|60)\b[^\n]*went from/.test(text), `${style}: a rider who stayed is said to move`);
        assert(!/\| 10 \| 7\d @ 0\.9 s/.test(text), `${style}: a flickered row reached the text`);
    }
});

await checkAsync('the membership log is written into the crash snapshot a piece at a time and reads back whole', async () => {
    const store = await openStore({indexedDB: new FakeIndexedDB()});
    const clock = new FakeClock();
    const saves = [];
    let last = null;
    let lastSave = clock.now();
    const r = new Recorder({now: () => clock.now(), sizeGuard: false, afterLineSeconds: 0,
        onChange: x => {
            if (x.state === 'recording' && clock.now() - lastSave >= 20000) {
                lastSave = clock.now();
                const snap = x.snapshotForCrash();
                // As JSON now: the snapshot shares its arrays with the recording, which goes on growing.
                last = JSON.parse(JSON.stringify(snap));
                saves.push(store.saveLive(snap, {rowsEpoch: x.rowsEpoch}));
            }
        }});
    runLongRace(r, clock, {seconds: 1500, afterSeconds: 0});
    await Promise.all(saves);
    const back = await store.loadLive();
    assert(last.moves.t.length > 100, 'the snapshot holds no moves');
    assertEq(JSON.stringify(back.moves), JSON.stringify(last.moves), 'the moves did not read back whole');
    assertEq(JSON.stringify(back.riders), JSON.stringify(last.riders));
});

check('nothing is added to the membership log after the line, and the race keeps all of it', () => {
    assertEq(JSON.stringify(RACE_0.moves), JSON.stringify(RACE_120.moves));
    const extra = BIG.moves.t.filter(t => t > BIG.afterLine.finishRaceSecond);
    assertEq(extra.length, 0, 'moves after the line');
});

check('YOUR FINISH says where you crossed in your group, and the groups ahead and behind', () => {
    const rec = withExtras(RACE_120, 1500);
    for (const style of styles) {
        const part = partOf(packOf(rec, style), 'YOUR FINISH');
        assert(part.includes('You crossed the line at 25:01.'), part);
        assert(part.includes('Your group at the line: 10 riders including you.'), part);
        assert(part.includes('On the road you crossed first of your group of 10: 9 reached the line after you, 0.2 to 1.8 s behind.'), part);
        assert(part.includes('Racer 2004 [SAUCE]') === false, part);
        assert(/Within about 1\.0 s of you[^\n]*Racer 2004 0\.2 s behind[^\n]*Racer 2008 1\.0 s behind\. The order between you and these riders is not certain\./.test(part), part);
        assert(/Group ahead: 4 riders \(Racer 2001( \[SAUCE\])?, Racer 2002( \[SAUCE\])?, Racer 2003, Rider A\), 1 min 46 s up the road as you crossed\. That is a gap on the road; when they crossed is not recorded\./.test(part), part);
        assert(part.includes('the first of them reached the line 43.6 s after you'), part);
        assert(part.includes('not yet at the line when the recorder stopped watching: 2.'), part);
        assert(part.includes('Zwift\'s live position as you crossed: 8 of 46.'), part);
        assert(part.includes('Official results were not fetched'), part);
        assert(part.includes('Distance note, not part of the race story'), part);
    }
    const none = partOf(packOf(withExtras(RACE_0, 1500), 'commentary'), 'YOUR FINISH');
    assert(none.includes('did not watch past the line, so where you crossed within your group is not known'), none);
});

check('WHO DID WHAT IN YOUR GROUP: each rider\'s power and draft in the rider\'s group, by seq, never after the line', () => {
    // Van, 22 Sep 2026: "let's include it", to call out most and least in the draft and highest and
    // lowest power. Kept only with IndexedDB (the size guard off); the fallback keeps the race first.
    const r = recordSynthetic({sizeGuard: false}).finished[0];
    const g = r.inGroup;
    assert(g && g.t.length > 20, 'no rows');
    assertEq(r.schema, 5);
    for (const key of ['t', 'rider', 'power', 'draft', 'wind', 'n']) {
        assertEq(g[key].length, g.t.length, `${key} is not one per row`);
    }
    assert(g.rider.includes(-1), 'the rider themselves are not ranked');
    const seqs = new Set(Object.values(r.riders).map(x => x.seq));
    assert(g.rider.every(x => x === -1 || seqs.has(x)), 'a row is not a known rider');
    assert(!JSON.stringify(g).includes(String(SELF_ID)), 'an athlete id in the rows');
    assert(Math.max(...g.t) <= r.timeline.t[r.timeline.t.length - 1], 'a row after the line');
    // With extra time after the line, nothing is added once the rider has finished.
    const withExtra = BIG;
    assert(Math.max(...withExtra.inGroup.t) <= withExtra.afterLine.finishRaceSecond, 'a row after the line');
    assert(g.t.every(t => t % 10 === 0), 'rows not every 10 s');
    // Not with the localStorage fallback, whose 400 kB a race keeps the race first.
    const small = recordSynthetic().finished[0];
    assertEq(small.inGroup.t.length, 0);
    // The texts: a section with the whole race, a line in each key moment, and the rules.
    const text = buildFactPack(r, {model: buildReport(r, {}), style: 'commentary'});
    const part = partOf(text, 'WHO DID WHAT IN YOUR GROUP');
    assert(/^Most draft .*; least /m.test(part) && /^Highest power .*; lowest /m.test(part), part);
    assert(text.split('\n').some(x => x.startsWith('In your group (')), 'no line in the key moments');
    const old = {...FULL, schema: 4, inGroup: undefined};
    assert(partOf(buildFactPack(old, {model: buildReport(old, {})}), 'WHO DID WHAT IN YOUR GROUP').includes('did not keep other riders\''),
           'an older recording does not say it has none');
    assert(partOf(buildFactPack(FULL, {model}), 'WHO DID WHAT IN YOUR GROUP').includes('Nobody\'s power or draft was recorded'),
           'a recording without the rows does not say so');
    for (const style of styles) {
        assert(/never "on the front" or "pulling"|No draft is not "on the front" or "pulling"/.test(PROMPTS[style]), style);
    }
});

check('sprints and KOMs from Zenmaster: first across and fastest, by its rules, with names and no ids', () => {
    // Van, 22 Sep 2026: "You should get it info from Arend's points mod", starting with the order.
    const config = {eventSubgroupId: 999, segments: [
        {name: 'Sprint', segmentId: '11', repeat: 1, enabled: true, scoreFormat: 'FAL,FTS'},
        {name: 'Sprint', segmentId: '11', repeat: 2, enabled: true, scoreFormat: 'FTS'},
        {name: 'KOM', segmentId: '22', repeat: 1, enabled: false, scoreFormat: 'FAL'},
        {name: 'Finish', segmentId: '33', repeat: 1, enabled: true, scoreFormat: 'FIN'},
    ]};
    const r = (athleteId, segmentId, ts, elapsed) => ({athleteId, segmentId, ts, worldTime: ts, elapsed, eventSubgroupId: 999});
    const results = [
        r(1, '11', 1000, 30.0), r(2, '11', 1400, 29.0), r(SELF_ID, '11', 2000, 31.5),
        r(1, '11', 90000, 28.0), r(2, '11', 90100, 28.5),
        r(1, '22', 50000, 100), r(1, '33', 99000, 5),
    ];
    const whoOf = id => ({1: {name: 'Racer One', team: 'MNSTRS'}, 2: {name: null, team: null}}[id] || {name: 'Test Rider', team: 'BCC'});
    const sp = segmentPointsFrom({config, results, whoOf, selfId: SELF_ID});
    assertEq(sp.segments.length, 2, 'the disabled KOM or the Finish was kept');
    const [first, second] = sp.segments;
    assertEq(first.fal.map(x => x.place + ':' + (x.name || '-')).join(' '), '1:Racer One 2:- 3:Test Rider');
    assertEq(first.fts[0].name, null, 'FTS is by elapsed time');
    assert(first.fal[2].self && Math.abs(first.fal[2].behind - 1.0) < 1e-9, JSON.stringify(first.fal[2]));
    assertEq(second.repeat, 2);
    assertEq(second.riders, 2, 'the second pass is each rider\'s second result');
    assert(!JSON.stringify(sp).includes('"athleteId"'), 'an athlete id was kept');
    const lines = segmentPointsLines(sp, {teamTag: 'mnstrs', teamKey: x => x.toLowerCase()});
    assert(lines[1].startsWith('Sprint (scored FAL and FTS), 3 riders:'), lines.join('\n'));
    assert(lines[2].includes('1 Racer One [MNSTRS], 2 (no name) +0.4 s, 3 you +1.0 s'), lines.join('\n'));
    assert(segmentPointsLines(sp, {includeNames: false}).join('\n').includes('(name withheld)'));
    assertEq(segmentPointsFrom({config, results: [], whoOf, selfId: SELF_ID}), null);
    // In the texts only when there are results, and the prompts give no points for them.
    const withSp = {...FULL, segmentPoints: sp};
    assert(buildFactPack(withSp, {model: buildReport(withSp, {})}).includes('=== SPRINTS AND KOMS, FROM ZENMASTER ==='));
    assert(!factPack.includes('SPRINTS AND KOMS'), 'the section without Zenmaster results');
    for (const style of styles) {
        assert(PROMPTS[style].includes("sprint and KOM results (from Zenmaster or Zwift's segment times)"), style);
    }
});

check('sprints and KOMs from Zwift\'s segment times when Zenmaster saved none: every pass, race riders only', () => {
    // The fallback for a race without Zenmaster, fetched with the official results.
    const segments = [{id: '-11', name: 'Sprint', loop: false}, {id: '-22', name: 'KOM', loop: false}];
    const r = (athleteId, ts, elapsed) => ({athleteId, ts, worldTime: ts, elapsed});
    const bySegment = new Map([
        ['-11', [r(1, 1000, 20), r(2, 1500, 19), r(99, 900, 15), r(1, 60000, 21), r(2, 60200, 20.5)]],
        ['-22', []],
    ]);
    const whoOf = id => ({1: {name: 'Racer One', team: null}, 2: {name: 'Racer Two', team: 'MNSTRS'}}[id]);
    const sp = segmentPointsFromZwift({segments, bySegment, participants: new Set([1, 2]), whoOf, selfId: null});
    assertEq(sp.source, 'zwift');
    assertEq(sp.segments.map(x => `${x.name} ${x.repeat}`).join(', '), 'Sprint 1, Sprint 2', 'passes');
    assertEq(sp.segments[0].fal.map(x => x.name).join(', '), 'Racer One, Racer Two', 'rider 99 was not in the race');
    assertEq(sp.segments[0].fts[0].name, 'Racer Two');
    const lines = segmentPointsLines(sp);
    assert(lines[0].includes('Which of them the organiser scored is not known'), lines[0]);
    assert(lines.some(x => x.startsWith('Sprint, pass 2, 2 riders:')), lines.join('\n'));
    const withSp = {...FULL, segmentPoints: sp};
    assert(buildFactPack(withSp, {model: buildReport(withSp, {})}).includes("=== SPRINTS AND KOMS, FROM ZWIFT'S SEGMENT TIMES ==="));
    // The near miss: 12th fastest, how far off 10th.
    const many = new Map([['-11', Array.from({length: 12}, (_, i) => r(i + 1, 1000 + i * 100, 20 + i * 0.1))]]);
    const sp12 = segmentPointsFromZwift({segments, bySegment: many, participants: new Set(Array.from({length: 12}, (_, i) => i + 1)),
                                         whoOf: () => ({name: 'Racer'}), selfId: 12});
    assert(segmentPointsLines(sp12).join('\n').includes('12 you 21.1 s, 0.2 s off 10th'), segmentPointsLines(sp12).join('\n'));
});

check('a team tag is given once per rider, and only when it looks like a team code', () => {
    // 17 Sep 2026: "[HBRD]" at every mention, and one rider's tag "@bluesky | RtB | ...".
    assertEq(shortTag('HBRD'), 'HBRD');
    assertEq(shortTag('TugaZ'), 'TugaZ');
    assertEq(shortTag('@bluesky | RtB | \u26aa\u26abMata Zyclik\u26ab\u26aa'), null);
    assertEq(tagOnce('A [X] went. Then A [X] and B [Y]. B [Y].', [['A', 'X'], ['B', 'Y']]),
             'A [X] went. Then A and B [Y]. B.');
    for (const style of styles) {
        const text = packOf(BIG, style);
        const body = text.slice(PROMPTS[style].length);
        for (const m of new Set(body.match(/[A-Za-z]+ \d+ \[[A-Z]+\]/g) || [])) {
            assertEq(body.split(m).length - 1, 1, `${style}: ${m} tagged more than once`);
        }
    }
});

check('both prompts forbid guessing a rider\'s gender, and the commentary holds to its length', () => {
    for (const style of styles) {
        assert(PROMPTS[style].includes('never "he", "she", "his" or "her"'), style);
        assert(PROMPTS[style].includes('only the first time'), style);
    }
    assert(PROMPTS.commentary.includes('250 to 400 words, and no more'));
    // Van, 18 Sep 2026: the debrief as bullets, each thing once, about 400 words.
    assert(PROMPTS.debrief.includes('About 500 words, and no more than 550'));
    assert(PROMPTS.debrief.includes('Say each thing once'));
});

check('WHO WAS WHERE leaves out a change of group undone within a minute', () => {
    const ctx = {replay: {list: [
        [100, 1, 0, 1, true], [100, 2, 0, 1, false], [130, 2, 1, 0, false], [100, 3, 0, 1, false], [300, 3, 1, 0, false],
    ]}};
    assertEq(withoutBriefChanges(ctx, {t: 100, from: 0, to: 1, seqs: [2]}), null);
    assertEq(withoutBriefChanges(ctx, {t: 130, from: 1, to: 0, seqs: [2]}), null);
    assertEq(JSON.stringify(withoutBriefChanges(ctx, {t: 100, from: 0, to: 1, seqs: [2, 3]}).seqs), '[3]');
    const text = partOf(packOf(BIG, 'commentary'), 'WHO WAS WHERE, BETWEEN THE KEY MOMENTS');
    assert(text.includes('within 60 s is left out'), text);
});

check('key moments are found by the fixed rules and carry their own times', () => {
    // The debrief's: the commentary's leave out the rider's own efforts (the next check).
    const text = buildFactPack(FULL, {model, style: 'debrief'});
    const heads = text.split('\n').filter(x => x.startsWith('--- MOMENT'));
    assertEq(heads.length, 3, heads.join('\n'));
    assert(heads[0].startsWith('--- MOMENT 1: 0:01 to 2:39'), heads[0]);
    assert(text.includes('Why: the start; a hard effort by you from 0:01 to 1:59.'));
    assert(/Why: your group went from 14 to 10 riders; a hard effort by you from 10:00 to 11:39; your group split: 4 riders of it now in a group ahead of you( \([^)]*\))?\./.test(text));
    assert(text.includes('Why: a hard effort by you from 23:01 to 25:00; the finish.'));
    // Where riders were before and after, never who moved (moveLine in racefacts.mjs).
    // A tag is given only the first time a rider is named (tagOnce), so it may or may not be here.
    assert(/10:20: Racer 2001( \[SAUCE\])?, Racer 2002( \[SAUCE\])?, Racer 2003, Rider A, in your group until then, in the group ahead of yours from then on/.test(text));
    assert(partOf(text, 'CLIMBS').includes('Climb 1: 10:00 to 11:39 (1m 40s), 715 m at 6.2%'), partOf(text, 'CLIMBS'));
    assert(/10:21 to 11:40: group ahead \([^)]*\) went from 0\.1 s to 9\.5 s, growing by about 7\.1 s a minute; your power 403 W, your group's average 300 W\./.test(text), partOf(text, 'HOW THE GAPS MOVED'));
});

check('the debrief gives W\'bal as a share, W/kg beside watts, and the reserve before the next effort', () => {
    const part = partOf(debriefPack, 'YOUR BIGGEST EFFORTS AND WHAT THEY COST');
    assert(part.includes('10:00 to 11:39 (1m 40s)'), part);
    assert(part.includes('Power 405 W (5.4 W/kg, 135 percent of FTP)'), part);
    assert(part.includes('Reserve before your next hard effort, at 10:00: 88%.'), part);
    assert(part.includes('W\'bal model: 88% at 10:00, 35% (7078 J) at 11:39, the lowest.'), part);
    assert(part.includes('This was your last hard effort before the line.'), part);
    // This recording saved no W', so the shares are of the highest W'bal it holds, and it says so.
    assert(debriefPack.includes('critical power of 300 W (your FTP, as no critical power is set in Sauce) and a W\' that was not saved with this recording. ' +
        'The shares below are of the highest W\'bal the record holds, 19940 J'), partOf(debriefPack, 'HOW TO READ THESE FACTS'));
    const withW = buildFactPack({...FULL, self: {...FULL.self, cp: 290, wPrime: 25000}}, {model, style: 'debrief'});
    assert(withW.includes('critical power of 290 W and a W\' of 25000 J from your profile'));
    // 20000 J exactly is what Sauce stores when no W' was set (src/stats.mjs:2296-2297), as on 17 Sep 2026.
    const withDefault = buildFactPack({...FULL, self: {...FULL.self, cp: null, wPrime: 20000}}, {model, style: 'debrief'});
    assert(withDefault.includes('a W\' of 20000 J, which is Sauce\'s default, stored when no W\' has been set'),
           partOf(withDefault, 'HOW TO READ THESE FACTS'));
    assert(!/\d{4,5} J\) at [^\n]*\d{4,5} J\)/.test(part), 'joules given more than once in a line');
});

check('earlier races are summarised by the same rules, and an incomplete one withholds its start and W\'bal', () => {
    const late = recordSynthetic({startAtSecond: 400}).finished[0];
    assert(late.incomplete, 'the late recording is not incomplete');
    const text = buildFactPack(FULL, {model, style: 'debrief', earlier: [FULL, {...late, event: makeEventInfo()}, FULL, FULL]});
    const part = partOf(text, 'YOUR EARLIER RACES');
    assertEq(part.split('\n').filter(x => /^\d{4}-\d\d-\d\d: /.test(x)).length, MAX_EARLIER_RACES);
    assert(part.includes('first minute 360 W'), part);
    assert(part.includes('NOT a complete record'), part);
    const lateLines = part.split('\n\n')[0].split(/\n(?=\d{4}-)/)[2];
    assert(!lateLines.includes('first minute') && lateLines.includes('no lowest W\'bal'), lateLines);
    assert(partOf(buildFactPack(FULL, {model, style: 'debrief'}), 'YOUR EARLIER RACES').includes('No earlier race'));
});

check('team tags and the group\'s average power appear as Sauce shows them, and team tags go with the names', () => {
    assert(factPack.includes('Racer 2001 [SAUCE]'), 'no team tag');
    assert(RACE.riders['2001'].team === 'SAUCE' && RACE.riders['Rider A'].team === null);
    // Labelled as the rider's own group's figure wherever it sits, even beside another group.
    assert(factPack.includes('your group\'s average 300 W'));
    assert(!/[^s] group average/.test(factPack), 'a bare "group average" that could be read as another group\'s');
    assert(factPack.includes('"Your group\'s average" is Sauce\'s average power over your whole group, you included.'));
    for (const style of styles) {
        const anon = buildFactPack(FULL, {model, style, includeNames: false});
        assert(!anon.includes('[SAUCE]'), `${style}: a team tag went out with names withheld`);
        assert(!/Racer \d+/.test(anon), `${style}: a name went out with names withheld`);
    }
});

check('climbs are named only from a route segment Sauce has for that road', () => {
    const part = partOf(packOf(BIG, 'commentary'), 'CLIMBS');
    assertEq((part.match(/Sauce's route segment for this road: Test Ridge KOM\./g) || []).length, 5, part);
    assert(!part.includes('Test Lap Banner'), 'a whole-lap segment named a climb');
    assert(!partOf(factPack, 'CLIMBS').includes('route segment for this road:'), 'a climb was named without a segment');
    assertEq(BIG.timeline.roadEvents.length > 5, true);
    assertEq(BIG.timeline.roadTime.length, BIG.timeline.t.length);
});

check('powerups give their span, grade and group, and one general line each, not measured', () => {
    assertEq(prettyPowerUp('LIGHTNESS'), 'Feather');
    const part = partOf(packOf(BIG, 'debrief'), 'POWERUPS ACTIVE ON YOU');
    assert(/20:50 to 21:04: Feather, on a [\d.]+% grade, [\d.]+ km from the line, in a group of \d+\./.test(part), part);
    assert(part.includes('What these do, in general Zwift terms, not measured in this race: Feather makes you lighter'), part);
    assert(!/\d/.test(part.split('not measured in this race: ')[1].split('\n')[0]), 'a powerup line carries a number');
});

check('the race commentary is about the field: no moment built on the rider\'s effort, and none of the rider\'s power', () => {
    // Van, 18 Sep 2026: "it brought me up a lot which it shouldn't".
    for (const text of [factPack, packOf(BIG, 'commentary')]) {
        assert(!text.includes('a hard effort by you'), 'a key moment built on the rider\'s effort');
        assert(!text.includes('Your hard effort in it'), 'the rider\'s effort in a moment');
        assert(!text.includes('YOUR WHOLE RACE, IN BRIEF'), 'the rider\'s whole race numbers');
        assert(!/^ {2}You \d+ W/m.test(partOf(text, 'CLIMBS')), partOf(text, 'CLIMBS'));
    }
    assert(factPack.includes('--- MOMENT 1: 0:01'), 'the start is still a key moment');
});

check('the texts fit: commentary under 24 kB and debrief under 30 kB on a normal race, both under the hard cap on a long one', () => {
    const earlier = [FULL, FULL, FULL];
    // 22 kB since 18 Sep 2026: the team commentary's prompt and THE RACE IN BRIEF added about 1 kB.
    // 24 kB since 22 Sep 2026: TERRAIN and each moment's road added about 1 kB.
    assert(factPack.length < 24000, `commentary ${factPack.length}`);
    const debrief = buildFactPack(FULL, {model, style: 'debrief', earlier});
    assert(debrief.length < 30000, `debrief ${debrief.length}`);  // 30 kB since the stretch by stretch section, 22 Sep 2026
    for (const style of styles) {
        for (const includeNames of [true, false]) {
            const text = packOf(BIG, style, {earlier: [BIG, BIG, BIG], includeNames});
            const moments = text.split('\n').filter(x => x.startsWith('--- MOMENT')).length;
            // The commentary's moments leave out the rider's own efforts, so it may have fewer.
            assert(style === 'debrief' ? moments === 8 : moments >= 5 && moments <= 8,
                   `${style}: ${moments} moments on the long race`);
            assert(text.length <= HARD_CAP_CHARACTERS, `${style} on the long race is ${text.length} characters`);
        }
    }
});

check('no em dash in either prompt or anything either text says', () => {
    const texts = [PROMPTS.commentary, PROMPTS.debrief, factPack, debriefPack,
                   ...styles.map(style => packOf(BIG, style, {earlier: [FULL]})),
                   ...styles.map(style => packOf(withExtras(RACE_120, 1500), style, {includeNames: false}))];
    for (const t of texts) {
        assert(!t.includes('—'), `an em dash: ${t.slice(Math.max(0, t.indexOf('—') - 60), t.indexOf('—') + 20)}`);
    }
});

check('a recording made before the membership log still gives both texts, and says what it lacks', () => {
    const old = {...FULL};
    delete old.moves;
    old.riders = Object.fromEntries(Object.entries(FULL.riders).map(([k, r]) => {
        const x = {...r};
        delete x.seq;
        delete x.team;
        return [k, x];
    }));
    for (const style of styles) {
        const text = buildFactPack(old, {model: buildReport(old, {}), style});
        assert(text.includes('did not keep who was in the other groups'), text.slice(0, 200));
        assert(text.includes('=== YOUR FINISH ==='));
    }
    const realFile = Path.resolve(MOD_DIR, '..',
        'race-report-Stage-2-Zwift-Crit-Club-DURA-ACE-Mech-Isle-Loop-2026-09-16-09-41-07.json');
    if (FS.existsSync(realFile)) {
        const real = JSON.parse(FS.readFileSync(realFile, 'utf8'));
        for (const style of styles) {
            const text = buildFactPack(real, {model: buildReport(real, {}), style});
            assert(text.includes('This recording did not reach the finish line, so your finish is not known.'), style);
            assert(text.includes('Powerups the organiser listed: Feather, Anvil'), 'LIGHTNESS is not shown as Feather');
        }
    }
});

check('the window has two copy buttons named for their purpose, sharing the names box', () => {
    const html = FS.readFileSync(Path.join(MOD_DIR, 'race-report.html'), 'utf8');
    assert(html.includes('id="btn-copy-commentary" data-style="commentary"'), 'no commentary button');
    assert(html.includes('>Copy race commentary for AI (to share)</button>'));
    assert(html.includes('id="btn-copy-debrief" data-style="debrief"'), 'no debrief button');
    assert(html.includes('>Copy coach\'s debrief for AI</button>'));
    assert(!html.includes('id="btn-copy"'), 'the old single button is still there');
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/for \(const btn of \[\$\('#btn-copy-commentary'\), \$\('#btn-copy-debrief'\)\]\)/.test(ui));
    assert(/buildFactPack\(rec, \{\s*style,[\s\S]{0,120}includeNames: !!store\.settings\(\)\.namesInCopy/.test(ui),
           'the names box does not govern both texts');
    assert(ui.includes('recorder.setRiderName(ids[i], name, typeof a.team'), 'team tags are not passed on');
    assert(ui.includes('Common.rpc.getSegmentsForRoad('), 'segments are not looked up');
    assert(DEFAULT_SETTINGS.namesInCopy === true, 'names are not on by default');
});


/* ----------------------------------------------------------------- after the review of 16 Sep 2026 */

// A short race driven payload by payload, for the edges of the hold (reviews of 16 Sep 2026).
function driveGroups(seconds, groupsAt, {skip = () => false, after = 0} = {}) {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), sizeGuard: false,
                            afterLineSeconds: after});
    const endDistance = seconds * 11 + 3;
    for (let t = 1; t <= seconds + 1 + after; t++) {
        clock.t += 1000;
        if (skip(t)) {
            continue;
        }
        r.onSelf(makeSelfPayload({t, stateTime: t, eventSubgroupId: 999, power: 250, hr: 150, cadence: 90,
            speed: 40, draft: 40, distance: t * 11, eventDistance: t > seconds ? endDistance + (t - seconds) * 11 : t * 11,
            grade: 0.01, wBal: 20000, eventPosition: 10, eventParticipants: 30, activePowerUp: null, endDistance}));
        const {ahead = [], mine, behind = []} = groupsAt(t);
        r.onGroups(makeGroupsPayload({aheadGroups: ahead, myGroup: mine, behindGroups: behind}));
        if (t % 10 === 0) {
            for (const id of r.unnamedRiderIds()) {
                r.setRiderName(id, `Racer ${id}`);
            }
        }
    }
    const rec = finished[0];
    return {...rec, self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 75},
            event: {name: 'Hold edges', endDistance, routeName: 'Hold edges'}};
}
const grp = (ids, gap) => ({ids, gap, power: 250, draft: 40, hr: 150, speed: 40, id: ids[0]});
const idRange = (a, b) => Array.from({length: b - a + 1}, (_, i) => a + i);
// The log's changes after each rider's first placing, as [t, key, from, to].
const loggedChanges = rec => {
    const keyOf = new Map(Object.entries(rec.riders).map(([k, r]) => [r.seq, k]));
    const seen = new Set();
    return rec.moves.t.map((t, i) => [t, keyOf.get(rec.moves.rider[i]), rec.moves.from[i], rec.moves.to[i]])
        .filter(x => {
            const first = !seen.has(x[1]);
            seen.add(x[1]);
            return !first;
        });
};

check('THE GROUPS ON THE ROAD: a split of the group ahead is called out, a flicker is not', () => {
    // A tester, 22 Sep 2026: "a good race report would have called out the group splitting apart
    // ahead of me." A group of 7 ahead: at 400 s, 5 of them go clear; at 200 s one payload shows it
    // split in two, which must not count.
    const front = idRange(8001, 8007);
    const rec = driveGroups(900, t => {
        const mine = grp([SELF_ID, ...idRange(8101, 8104)], 0);
        if (t >= 400) {
            return {ahead: [grp(front.slice(0, 5), -40 - (t - 400) * 0.05), grp(front.slice(5), -38)], mine};
        }
        if (t === 200) {
            return {ahead: [grp(front.slice(0, 3), -31), grp(front.slice(3), -30)], mine};
        }
        return {ahead: [grp(front, -30)], mine};
    });
    assert(rec.roadGroups && rec.roadGroups.t.length > 100, 'no road groups');
    const text = buildFactPack(rec, {model: buildReport(rec, {})});
    const part = partOf(text, 'THE GROUPS ON THE ROAD');
    const splits = part.split('\n').filter(x => x.includes(' split, '));
    assertEq(splits.length, 1, part);
    assert(/^6:4\d \([^)]*\): the group of 7 .* ahead of yours split, 5 riders left in it and 2 now .* ahead\.$/.test(splits[0]), splits[0]);
    assert(/^at \d+:\d\d: 7 @ 30\.0 s 40 km\/h \| 5 40 km\/h \| -$/m.test(part), part);
    assert(!/^\d+:\d\d \| /m.test(part), 'a road line reads as a row of the minute table');
});

check('the rider\'s own brief loss of contact is in the debrief, named', () => {
    // A tester's write-up: "Briefly lost touch with [two riders] on the flat top of the climb, but caught them".
    const pair = idRange(8201, 8203);
    const rec = driveGroups(900, t => t >= 400 && t < 440 ?
        {ahead: [grp(pair, -3)], mine: grp([SELF_ID], 0)} : {mine: grp([SELF_ID, ...pair], 0)});
    const part = partOf(buildFactPack(rec, {model: buildReport(rec, {}), style: 'debrief'}), 'YOUR RACE STRETCH BY STRETCH');
    assert(/you lost contact with .*8201.*, back with them at 7:2\d/.test(part), part);
});

check('riders really dropped whom Sauce shows by turns behind and further back are logged leaving your group', () => {
    const bunch = idRange(7007, 7030);
    const rec = driveGroups(900, t => {
        if (t < 300) {
            return {mine: grp([SELF_ID, ...idRange(7001, 7006), ...bunch], 0)};
        }
        const gap = Math.min(30, 3 + (t - 300) * 0.1);
        return t % 2 ?
            {mine: grp([SELF_ID, ...bunch], 0), behind: [grp(idRange(7001, 7006), gap)]} :
            {mine: grp([SELF_ID, ...bunch], 0), behind: [grp([7005, 7006], gap), grp(idRange(7001, 7004), gap + 2.1)]};
    }, {after: 30});
    const moves = loggedChanges(rec);
    assertEq(moves.length, 6, JSON.stringify(moves));
    for (const [t, , from, to] of moves) {
        assert(from === 0 && to === 1 && t >= 300 && t <= 301, JSON.stringify(moves));
    }
    const part = partOf(packOf(rec, 'commentary'), 'YOUR FINISH');
    assert(part.includes('Your group at the line: 25 riders including you.'), part);
});

check('a flicker on two payloads either side of a gap in the feed is not a change that held', () => {
    const others = idRange(8001, 8020);
    const rec = driveGroups(900, t => (t === 400 || t === 407) ?
        {mine: grp([SELF_ID, ...others.slice(1)], 0), behind: [grp([8001], 0.9)]} :
        {mine: grp([SELF_ID, ...others], 0)}, {skip: t => t > 400 && t < 407});
    assertEq(loggedChanges(rec).length, 0, JSON.stringify(loggedChanges(rec)));
});

check('a split in the last seconds before the line is logged, so your group at the line is right', () => {
    const bunch = idRange(9006, 9020);
    const rec = driveGroups(1200, t => t >= 1196 ?
        {ahead: [grp(idRange(9001, 9005), -1.5)], mine: grp([SELF_ID, ...bunch], 0)} :
        {mine: grp([SELF_ID, ...idRange(9001, 9005), ...bunch], 0)}, {after: 30});
    const moves = loggedChanges(rec);
    assertEq(moves.map(x => `${x[0]}:${x[1]}:${x[3]}`).join(','),
             idRange(9001, 9005).map(id => `1196:${id}:-1`).join(','));
    const part = partOf(packOf(rec, 'commentary'), 'YOUR FINISH');
    assert(part.includes('Your group at the line: 16 riders including you.'), part);
    assert(part.includes('Group ahead: 5 riders (Racer 9001, Racer 9002, Racer 9003, Racer 9004, Racer 9005), 1.5 s up the road'), part);
    // One payload of flicker at the line is still nothing.
    const once = driveGroups(1200, t => t === 1200 ?
        {ahead: [grp(idRange(9001, 9005), -1.5)], mine: grp([SELF_ID, ...bunch], 0)} :
        {mine: grp([SELF_ID, ...idRange(9001, 9005), ...bunch], 0)}, {after: 30});
    assertEq(loggedChanges(once).length, 0);
});

check('a real group straddling Sauce\'s cut behind you logs no change between behind and further back', () => {
    // Eight riders dropped at 200 s, whom Sauce's 2 s cut splits in two on a random half of the
    // payloads, as in the review's 3 hour race.
    const rnd = seeded(11);
    const bunch = idRange(5001, 5040);
    const rec = driveGroups(1800, t => {
        if (t < 200) {
            return {mine: grp([SELF_ID, ...bunch, ...idRange(5091, 5098)], 0)};
        }
        const gap = Math.min(60, 3 + (t - 200) * 0.1);
        const ids = idRange(5091, 5098);
        return {mine: grp([SELF_ID, ...bunch], 0),
                behind: rnd() < 0.5 ? [grp(ids, gap)] : [grp(ids.slice(0, 4), gap), grp(ids.slice(4), gap + 2.1)]};
    });
    const moves = loggedChanges(rec);
    assertEq(moves.filter(x => x[2] !== 0).length, 0, JSON.stringify(moves.filter(x => x[2] !== 0).slice(0, 5)));
    assertEq(moves.filter(x => x[2] === 0).length, 8, 'the eight were not logged leaving once each');
    assert(SAME_SIDE_HOLD_FACTOR * MOVE_HOLD_SECONDS >= 20);
});

check('a rider really in the group behind, shown further back on a third of the payloads, is placed behind and stays there', () => {
    const roster = new Roster();
    roster.see(1, 0);
    const rnd = seeded(3);
    const log = [];
    for (let t = 1; t <= 1200; t++) {
        const m = roster.observePlace(1, rnd() < 0.3 ? 2 : 1, t, MOVE_HOLD_SECONDS);
        if (m) {
            log.push(m);
        }
    }
    assertEq(JSON.stringify(log.map(x => x.slice(1))), JSON.stringify([[0, null, 1]]));
});

check('a flicker on every other payload for twelve seconds is no split, in the texts or the window, on either beat', () => {
    for (const beat of [0, 1]) {
        const others = idRange(6001, 6060);
        const rec = driveGroups(1200, t => t >= 600 && t < 612 && t % 2 === beat ?
            {ahead: [grp(others.slice(0, 51), -0.9)], mine: grp([SELF_ID, ...others.slice(51)], 0)} :
            {mine: grp([SELF_ID, ...others], 0)});
        assertEq(findSplits(splitSizes(rec)).length, 0, `beat ${beat}`);
        const m = buildReport(rec, {});
        assert(!JSON.stringify(m.sections).includes('your group went from'), `beat ${beat}: the window shows a split`);
        for (const style of styles) {
            const text = buildFactPack(rec, {model: m, style});
            assert(!/your group went from \d+ to \d+/.test(text), `beat ${beat} ${style}: a split in the text`);
            assert(!/\| 10 \|/.test(text), `beat ${beat} ${style}: a flickered size in a row`);
        }
    }
});

// The long race's true road (runLongRace in synthetic-feed.mjs), for the checks against it below.
function longTruth(t) {
    let bunch = idRange(4001, 4080);
    const take = ids => {
        bunch = bunch.filter(x => !ids.includes(x));
        return ids;
    };
    const ahead = [];
    const behind = [];
    if (t >= 300 && t < 900) {
        ahead.push({ids: take([4001, 4002, 4003]), gap: t < 700 ? (t - 300) * 0.15 : (900 - t) * 0.3});
    }
    if (t >= 1300) {
        ahead.push({ids: take(t >= 2600 ? idRange(4001, 4017) : idRange(4001, 4020)), gap: Math.min(120, (t - 1300) * 0.2)});
    }
    if (t >= 3000) {
        ahead.push({ids: take(idRange(4021, 4025)), gap: Math.min(40, (t - 3000) * 0.1)});
    }
    if (t >= 3640) {
        behind.push({ids: take(idRange(4061, 4070)), gap: Math.min(60, (t - 3640) * 0.2)});
    }
    if (t >= 1320) {
        behind.push({ids: take(idRange(4071, 4076)), gap: Math.min(200, (t - 1320) * 0.15)});
    }
    ahead.sort((a, b) => a.gap - b.gap);
    behind.sort((a, b) => a.gap - b.gap);
    return {mine: bunch.length + 1, ahead: ahead[0] || null, behind: behind[0] || null};
}
const clockSeconds = x => x.split(':').reduce((a, v) => a * 60 + Number(v), 0);

check('over many seeds of the flickering field, no size, group or split in either text is one the road never had', () => {
    const sizes = new Set([81, 78, 61, 55, 58, 53, 43]);
    for (const seed of [1, 2, 3, 5, 8, 9, 13, 21, 23, 34]) {
        const rec = recordLong({seed});
        const m = buildReport(rec, {});
        for (const style of styles) {
            const text = buildFactPack(rec, {model: m, style});
            assertEq((text.match(/your group went from (\d+) to (\d+) riders/g) || []).join(';'),
                     'your group went from 81 to 55 riders', `seed ${seed} ${style}`);
            const rows = text.split('\n').filter(x => /^\d+:\d\d(-\d+:\d\d)? \| /.test(x));
            assert(rows.length > 40, `seed ${seed} ${style}: ${rows.length} rows`);
            for (const row of rows) {
                const cells = row.split(' | ');
                const overview = cells[0].includes('-');
                const t = clockSeconds(cells[0].split('-').pop());
                const i = style === 'commentary' ? (overview ? 3 : 4) : (overview ? 6 : 8);
                assert(sizes.has(Number(cells[i])), `seed ${seed} ${style}: ${row}`);
                const sides = style === 'commentary' ? [[cells[overview ? 5 : 5], 'ahead'], [cells[6], 'behind']] :
                    [[cells[overview ? 7 : 9], 'ahead']];
                for (const [cell, side] of sides) {
                    if (cell === '-') {
                        continue;
                    }
                    const n = Number(cell.split(' @ ')[0]);
                    // The size a group on that side really had within a few seconds of the row.
                    const real = idRange(t - 8, t + 8).some(x => longTruth(x)[side] && longTruth(x)[side].ids.length === n);
                    assert(real, `seed ${seed} ${style}: a group of ${n} ${side} that was never there: ${row}`);
                }
            }
        }
    }
});

check('YOUR FINISH does not give the group ahead a gap that belongs to a fragment that formed in the last seconds', () => {
    const rec = JSON.parse(JSON.stringify(BIG));
    const p = rec.pack;
    p.t.forEach((t, i) => {
        if (t >= 3895 && t <= 3900) {
            p.sizeAheadGroup[i] = 1;
            p.gapAheadGroup[i] = -1.2;
        }
    });
    const part = partOf(packOf(rec, 'commentary'), 'YOUR FINISH');
    assert(/Group ahead: 5 riders \([^)]*\), 40\.0 s up the road as you crossed/.test(part), part);
    assert(!part.includes('1.2 s up the road'), part);
    // And with no row near the line that is the same group, the gap is said not to be known.
    p.t.forEach((t, i) => {
        if (t >= 3880) {
            p.sizeAheadGroup[i] = 1;
            p.gapAheadGroup[i] = -1.2;
        }
    });
    const none = partOf(packOf(rec, 'commentary'), 'YOUR FINISH');
    assert(none.includes('could not be matched to them, so it is not known'), none);
});

check('YOUR FINISH says where in your group you crossed when riders of it crossed before you', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), afterLineSeconds: 60});
    runLineFinish(r, clock, {race: 250, after: 70, riders: [
        {id: 501, gap: -0.6, group: 0, name: 'always'},
        {id: 502, gap: -0.3, group: 0, name: 'always'},
        {id: 503, gap: 0.4, group: 0, name: 'always'},
        {id: 504, gap: 0.9, group: 0, name: 'always'},
        {id: 505, gap: 1.6, group: 0, name: 'always'},
        {id: 601, gap: 20, group: 1, name: 'always'},
    ]});
    clock.t += 400_000;
    r.tick();
    const rec = {...finished[0], event: makeEventInfo(), self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5}};
    assertEq(rec.afterLine.aheadInGroup.map(x => `${x.rider}:${x.gap}`).sort().join(','), '501:-0.6,502:-0.3');
    for (const style of styles) {
        const part = partOf(packOf(rec, style), 'YOUR FINISH');
        assert(part.includes('On the road you crossed third of your group of 6: 2 were ahead of you on the road as you ' +
            'reached it, 0.3 to 0.6 s; 3 reached the line after you, 0.4 to 1.6 s behind.'), part);
        assert(part.includes('Racer 502 0.3 s ahead, Racer 501 0.6 s ahead, Racer 503 0.4 s behind, Racer 504 0.9 s behind.'), part);
    }
});

check('HOW THE GAPS MOVED never gives one rate across a gap that turned, and always reaches the line', () => {
    for (const style of styles) {
        const part = partOf(packOf(BIG, style), 'HOW THE GAPS MOVED');
        const lines = part.split('\n').filter(x => /^\d+:\d\d to \d+:\d\d: group/.test(x));
        assert(lines.length >= 6, part);
        for (const ln of lines) {
            const m = ln.match(/^(\d+:\d\d) to (\d+:\d\d): group (ahead|behind) .* went from .*?, (growing|shrinking|about the same)/);
            const [a, b] = [clockSeconds(m[1]), clockSeconds(m[2])];
            const gap = t => longTruth(t)[m[3]] && longTruth(t)[m[3]].gap;
            let against = 0;
            for (let t = a; t + 30 <= b; t += 5) {
                const d = gap(t + 30) - gap(t);
                if ((m[4] === 'growing' && d < -0.5) || (m[4] === 'shrinking' && d > 0.5)) {
                    against += 5;
                }
            }
            assert(against < 30, `${style}: the gap went the other way for ${against} s: ${ln}`);
        }
        for (const side of ['ahead', 'behind']) {
            assert(lines.some(x => x.includes(`group ${side}`) && clockSeconds(x.split(' to ')[1].split(':').slice(0, 2).join(':')) >= 3880),
                   `${style}: no stretch of the group ${side} reaches the line\n${part}`);
        }
    }
});

check('the debrief\'s next hard effort is the next one ridden, not the next one listed', () => {
    const part = partOf(packOf(BIG, 'debrief'), 'YOUR BIGGEST EFFORTS AND WHAT THEY COST');
    assert(part.includes('Reserve before your next hard effort, at 8:00 (1m 30s at 380 W, not one of the five listed):'), part);
    assert(part.includes('Reserve before your next hard effort, at 50:00 (30s at 480 W, not one of the five listed):'), part);
    assert(part.includes('3 other efforts met the same rule but did less work above FTP, so they are not listed: ' +
        '8:00 (1m 30s), 34:00 (1m 30s), 50:00 (30s).'), part);
});

check('no text passes the hard cap: a three hour race, long names with team tags, results and earlier races', () => {
    const clock = new FakeClock();
    const finished = [];
    const r = new Recorder({now: () => clock.now(), onFinalized: x => finished.push(x), afterLineSeconds: 120, sizeGuard: false});
    runLongRace(r, clock, {seconds: 3 * 3600});
    const base = finished[0];
    const endDistance = base.timeline.eventDistance.filter(x => x != null).pop();
    const long = 'Konstantinos Papadopoulos-Wojciechowski';
    const riders = Object.fromEntries(Object.entries(base.riders).map(([k, x], i) =>
        [k, {...x, name: x.name ? `${long} ${i}` : null, team: x.name && i % 3 === 0 ? 'ZRL-TEAM' : x.team}]));
    const rec = {...base, riders, event: makeLongEventInfo(endDistance, 3 * 3600), segments: LONG_RACE_SEGMENTS,
                 self: {athleteId: SELF_ID, name: 'Test Rider', ftp: 300, weight: 74.5},
                 stats: makeLongRaceStats(3 * 3600),
                 results: Array.from({length: 80}, (_, i) => ({place: i + 1, name: `${long} ${i}`, timeSeconds: 10800 + i * 3, avgWatts: 280, flags: null}))};
    const m = buildReport(rec, {});
    for (const style of styles) {
        for (const includeNames of [true, false]) {
            const text = buildFactPack(rec, {model: m, style, includeNames, earlier: [rec, rec, rec]});
            assert(text.length <= HARD_CAP_CHARACTERS, `${style} ${includeNames}: ${text.length} characters`);
            if (includeNames) {
                assert(text.includes('To fit in a chat box this text was shortened: '), `${style}: it does not say it was shortened`);
            }
            assert(text.includes('=== WHAT IS NOT KNOWN ==='), `${style}: a hard limit was cut`);
        }
    }
    // A text that fits is not shortened.
    assert(!factPack.includes('was shortened'));
});

check('the debrief gives best power once, Sauce\'s peaks where it has them, and no average of missing seconds', () => {
    const text = packOf(BIG, 'debrief');
    assert(!text.includes('Best power inside the race: 5s'), 'the peaks are still given twice');
    assertEq(text.split('\n').filter(x => /^ {2}5 s: /.test(x)).length, 1);
    assert(text.includes('  5 s: 520 W (7.0 W/kg), Sauce\'s peak'), partOf(text, 'YOUR BIGGEST EFFORTS AND WHAT THEY COST'));
    // With no stats, from the rows, and a second missing from the best five is no five second best.
    const tl = {...FULL.timeline, t: [...FULL.timeline.t], power: [...FULL.timeline.power]};
    const i = tl.t.indexOf(62);
    tl.power.fill(250);
    tl.power.splice(i - 2, 5, 900, 900, 900, 900, 900);
    tl.t.splice(i, 1);
    tl.power.splice(i, 1);
    const holed = {...FULL, stats: null, timeline: tl};
    const lines = packOf(holed, 'debrief').split('\n').filter(x => /^ {2}5 s: /.test(x));
    assert(lines.length === 1 && !lines[0].startsWith('  5 s: 900 W'), lines.join('\n'));
});

check('every moment\'s rows reach the end of the moment, with at least three rows', () => {
    for (const style of styles) {
        const text = packOf(BIG, style);
        for (const block of text.split('\n--- MOMENT ').slice(1)) {
            const end = block.match(/^\d+: \d+:\d\d to (\d+:\d\d)/)[1];
            const rows = block.split('\n').filter(x => /^\d+:\d\d \| /.test(x));
            assert(rows.length >= 3, `${style}: ${rows.length} rows in a moment`);
            assertEq(rows[rows.length - 1].split(' | ')[0], end, `${style}: the rows stop short of ${end}`);
        }
    }
});

check('both prompts only point at sections the texts have', () => {
    for (const style of styles) {
        const text = packOf(BIG, style, {earlier: [FULL]});
        const heads = new Set(text.split('\n').filter(x => x.startsWith('=== ')).map(x => x.slice(4, -4).split(' (')[0]));
        for (const name of PROMPTS[style].match(/\b[A-Z][A-Z' ]{6,}[A-Z]\b/g).filter(x => !/^(RULES|HOW TO WRITE IT|RACE COMMENTARY|COACH'S DEBRIEF)$/.test(x))) {
            assert([...heads].some(h => h.startsWith(name)), `${style}: the prompt names ${name}, which the text does not have`);
        }
    }
});

check('changes of group say where riders were, not who moved, and a group between is said as such', () => {
    const text = packOf(BIG, 'commentary');
    assert(!/ went (from|into) (your|the|a) group/.test(text.split('=== RACE ===')[1]), 'a change still says riders went somewhere');
    // Said with the group now between, or as the group next to yours splitting (22 Sep 2026).
    assert(/(now between your group and|another group was now on the road between yours and) Racer 40\d\d|the group (ahead|behind) split: /.test(text), 'no group-between line');
    // The rider dropped from a bunch of 21: the others did not go clear.
    const bunch = idRange(5001, 5020);
    const rec = driveGroups(900, t => t < 400 ? {mine: grp([SELF_ID, ...bunch], 0)} :
        {ahead: [grp(bunch, -Math.min(20, (t - 400) * 0.1))], mine: grp([SELF_ID], 0)});
    const own = packOf(rec, 'commentary');
    assert(own.includes('your group split: 20 riders of it now in a group ahead of you'), partOf(own, 'KEY MOMENTS'));
    // Who moved (22 Sep 2026): most of the group went ahead, so the rider was dropped.
    assert(own.includes('(you were dropped)'), partOf(own, 'KEY MOMENTS'));
    assert(!/20 riders from your group went into/.test(own));
});

check('gap milestones are spread over the race, each group and line once', () => {
    const lines = partOf(packOf(BIG, 'commentary'), 'WHO WAS WHERE, BETWEEN THE KEY MOMENTS').split('\n')
        .filter(x => /^\d+:\d\d: the gap to the group/.test(x));
    assert(lines.length >= 4, lines.join('\n'));
    assert(lines.some(x => clockSeconds(x.split(': ')[0]) > 3000), `nothing after 50:00:\n${lines.join('\n')}`);
    assertEq(new Set(lines.map(x => x.split(': ').slice(1).join(': '))).size, lines.length, 'a milestone is listed twice');
});

check('an earlier race saved without its W\' gives its lowest W\'bal in joules, not as a share of a default', () => {
    const part = partOf(buildFactPack(FULL, {model, style: 'debrief', earlier: [FULL]}), 'YOUR EARLIER RACES');
    assert(/lowest W'bal \d+ J \(the W' it ran on was not saved with that race\)/.test(part), part);
    const withW = {...FULL, self: {...FULL.self, wPrime: 25000}};
    assert(/lowest W'bal \d+%/.test(partOf(buildFactPack(FULL, {model, style: 'debrief', earlier: [withW]}), 'YOUR EARLIER RACES')));
});

check('earlier races leave out recordings started by hand, other kinds of event, and this same race', () => {
    const cur = {id: 'b', trigger: 'auto', eventSubgroupId: 7, event: {eventType: 'GROUP_RIDE'}};
    assert(isEarlierRace({trigger: 'auto', eventSubgroupId: 6, eventType: 'RACE'}, cur));
    assert(isEarlierRace({trigger: 'auto', eventSubgroupId: 6, eventType: 'GROUP_RIDE'}, cur), 'a group ride listed like this one');
    assert(!isEarlierRace({trigger: 'manual', eventSubgroupId: 6, eventType: 'RACE'}, cur), 'a manual recording');
    assert(!isEarlierRace({trigger: 'auto', eventSubgroupId: 7, eventType: 'RACE'}, cur), 'the same race saved twice');
    assert(!isEarlierRace({trigger: 'auto', eventSubgroupId: 6, eventType: 'WORKOUT'}, cur), 'a workout');
    assert(isEarlierRace({eventType: 'RACE'}, cur), 'an old index entry with no trigger is checked on the race itself');
    const s = summarize(FULL);
    assertEq(s.trigger, 'auto');
    assertEq(s.eventSubgroupId, FULL.eventSubgroupId);
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    assert(/isEarlierRace\(x, rec\)[\s\S]{0,200}isEarlierRace\(prev, rec\)/.test(ui), 'the window does not filter the earlier races');
});

check('a race resumed after a crash reads the rider\'s profile, whichever way it closed', () => {
    const ui = FS.readFileSync(Path.join(MOD_DIR, 'src/ui.mjs'), 'utf8');
    const resume = ui.slice(ui.indexOf('async function offerResume()'), ui.indexOf('$(\'#resume-discard\')'));
    const branchesEnd = resume.indexOf('rec.elapsedSeconds = Math.round((rec.endedAt - rec.startedAt) / 1000);');
    assert(branchesEnd > 0 && resume.indexOf('await captureSelfProfile(rec);', branchesEnd) > branchesEnd,
           'the profile is not read after every branch');
});

/* ================================================================= results */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    for (const [name, e] of failures) {
        console.log(`\nFAILED: ${name}`);
        console.log(e.stack);
    }
    process.exitCode = 1;
} else {
    console.log(`
UNTESTED UNTIL A REAL RACE. None of the following can be exercised here, because they need
Sauce, Electron and Zwift:
  - that the mod appears in Settings > Windows after the folder is dropped in place;
  - that a persistent subscription really does keep delivering with the window hidden, and that
    Chromium's timer throttling does not reach the callback. The coverage numbers in every saved
    recording are what will answer this on the first real race;
  - that Sauce's sandbox allows the clipboard write, and that the manual fallback box appears if
    it does not;
  - where a downloaded file lands, since Sauce registers no will-download handler;
  - that the real athlete/self/v2 and groups/v2 payloads match the shapes in synthetic-feed.mjs
    field for field, in particular that state.worldTime and updated give Sauce's server clock
    offset the way the recorder reads them. state.time does NOT always count from the gun: on
    16 Sep 2026 it started 67 seconds after it, for a reason nobody knows;
  - that getCachedEvents already holds the rider's subgroup, with its scheduled start, before the
    gun in a real race, so the recording counts from the gun rather than falling back;
  - whether Zwift's state.time is 0 when a rider joins an event late, as the late join test
    assumes. If it is not, Zwift's clock is still never put before the join;
  - that a late join from Zwift's home screen sends no self payload before it, and that Zwift's
    event distance is near zero on the first one, which is what tells it from a window that
    came up late;
  - that createdServerTime plus Sauce's stream time is where each real stream sample sits on the
    server clock, which is how Sauce's streams are put on the gun clock (checked only against the
    peaks of the 16 Sep 2026 file, with the computer clock taken as the server's);
  - how often Sauce has no event id for a subgroup in its database. Then it never looks the
    subgroup up again by itself, the payload never carries Sauce's eventSubgroupId, and nothing
    records automatically until an event feed sync brings the event in;
  - the real packet rate of athlete/self/v2, and therefore whether a second is ever missed;
  - that IndexedDB opens and keeps its data across a Sauce restart in a real Sauce mod window
    (sandboxed, on Sauce's persistent session), so recordings are not in the localStorage
    fallback. The window's console says which store is in use once at startup, and every saved
    race carries it as storedIn;
  - whether the screen flicker Van saw on 16 Sep 2026 goes away now that nothing is written under
    a "/" key, which made Sauce's Watching window reload. It was never proven to be the cause. The
    overlays are expected to reload once, when the old keys are removed after the upgrade;
  - what navigator.storage.estimate() reports in a Sauce window, which sets the IndexedDB budgets,
    and whether navigator.storage.persist() is granted there;
  - the real localStorage ceiling in a Sauce profile, and what Sauce does when it is hit, which
    now matters only for the fallback;
  - getEventSubgroupResults against a finished event, and the exact field names it returns;
  - that the riders in a real groups/v2 payload carry their own remaining, which is how "After
    the line" tells that a rider behind has reached it;
  - how much Sauce's grouping really flickers in a big field, and whether holding a change of group
    for 5 s and a split for 10 s is enough to keep the flicker out of both copied texts, as it is
    for the synthetic field here;
  - that state.roadId, state.reverse and state.roadTime arrive on the rider's own payload, and that
    getSegmentsForRoad names the climb a rider was on, as Sauce's own active segment test would;
  - that getAthletes profiles carry the team tag, and getAthlete('self') the cp and wPrime Sauce's
    W'bal model runs on;
  - how an AI actually writes from either copied text on a real race, which synthetic data cannot
    show;
  - how long Zwift keeps the rider in the event after the finish (Sauce's "cooldown window"). If
    it is shorter than the setting, the extra time ends early and says Sauce stopped showing the
    rider in the event;
  - that a finish packet and Sauce's closed event slice line up in a real race, so the race saved
    at the line gets Sauce's stats and streams straight away;
  - whether the event the rider is in carries the powerup_percent tag;
  - anything about Sauce 2.3.3 specifically, for which upstream publishes no source.`);
}
