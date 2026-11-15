import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiUrl } from '../../lib/api';
import { AUTH_TOKEN_KEY } from '../../context/WebsiteDataContext';

/* Who is above or below an attendance threshold, per track and overall.
   Single-track participants are judged on their own track. Combo participants
   are eligible when either track clears the threshold; each track and the
   average are still shown so a split (clears one, misses the other) is visible.
   Read-only: nothing here writes to the database. */

const GROUPS = [
    ['all', 'All'],
    ['software', 'Software'],
    ['powertrain', 'Powertrain'],
    ['combo', 'Combo']
];
const VIEWS = [
    ['below', 'Below threshold'],
    ['eligible', 'Eligible'],
    ['split', 'Combo: one track only'],
    ['unreachable', "Can't reach anymore"],
    ['all', 'Everyone']
];
const GROUP_STYLE = {
    software: 'border-sky-500 bg-sky-100 text-sky-900',
    powertrain: 'border-amber-500 bg-amber-100 text-amber-900',
    combo: 'border-violet-500 bg-violet-100 text-violet-900'
};

async function fetchEligibility(threshold) {
    const token = sessionStorage.getItem(AUTH_TOKEN_KEY) || localStorage.getItem('admin_token');
    const res = await fetch(apiUrl(`/api/workshop/attendance/eligibility?threshold=${threshold}`), {
        headers: { Authorization: `Bearer ${token}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server HTTP ${res.status}`);
    return data;
}

const shortDate = (iso) =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—';

function pctTone(value, threshold) {
    if (value >= threshold) return 'text-emerald-700';
    if (value >= threshold - 10) return 'text-amber-700';
    return 'text-rose-700';
}

function TrackCell({ row, threshold }) {
    if (!row) return <span className="text-slate-300">—</span>;
    return (
        <div className="leading-tight">
            <span className={`font-black ${pctTone(row.percentage, threshold)}`}>{row.percentage}%</span>
            <span className="ml-1 text-[10px] font-bold text-slate-500">
                {row.present}/{row.conducted}
            </span>
            {!row.eligible && (
                <div className="text-[10px] font-bold text-slate-500">
                    {row.maxPossible < threshold
                        ? `max ${row.maxPossible}%`
                        : `needs ${row.sessionsToReach} in a row`}
                </div>
            )}
        </div>
    );
}

function Stat({ label, value, sub, tone = 'bg-white' }) {
    return (
        <div className={`border-2 border-slate-900 p-3 ${tone}`}>
            <div className="text-[10px] font-black tracking-wider text-slate-600 uppercase">{label}</div>
            <div className="text-2xl font-black text-slate-950">{value}</div>
            {sub && <div className="text-[11px] font-bold text-slate-600">{sub}</div>}
        </div>
    );
}

/* Applies a threshold to the per-track counts the server sent. Mirrors the
   server's rules: a track is cleared at >= threshold, a participant is eligible
   when any enrolled track is cleared (for combo: either one). */
function deriveAt(raw, threshold) {
    const t = threshold / 100;
    const toReach = (present, conducted) => {
        if (conducted === 0 || present / conducted >= t) return 0;
        if (t >= 1) return null;
        return Math.ceil((t * conducted - present) / (1 - t));
    };
    const people = raw.people.map((p) => {
        const perTrack = Object.fromEntries(
            Object.entries(p.perTrack).map(([k, r]) => [
                k,
                {
                    ...r,
                    eligible: r.conducted > 0 && r.percentage >= threshold,
                    sessionsToReach: toReach(r.present, r.conducted)
                }
            ])
        );
        const rows = Object.values(perTrack);
        const eligibleTracks = p.tracks.filter((k) => perTrack[k]?.eligible);
        return {
            ...p,
            perTrack,
            eligibleTracks,
            eligible: eligibleTracks.length > 0,
            split: p.group === 'combo' && eligibleTracks.length === 1,
            canStillReach: rows.some((r) => r.maxPossible >= threshold)
        };
    });

    const groupSummary = (group) => {
        const list = people.filter((p) => p.group === group);
        return {
            total: list.length,
            eligible: list.filter((p) => p.eligible).length,
            below: list.filter((p) => !p.eligible).length,
            neverAttended: list.filter((p) => p.neverAttended).length,
            cannotReach: list.filter((p) => !p.eligible && !p.canStillReach).length
        };
    };
    const combo = people.filter((p) => p.group === 'combo');
    // Buckets split at the threshold, so the bars read as below / above the line.
    const edges = [
        ...new Set([0, 25, 50, threshold - 10, threshold, threshold + 15 < 100 ? threshold + 15 : -1, 101])
    ]
        .filter((e) => e >= 0 && e <= 101)
        .sort((a, b) => a - b);
    const distribution = edges.slice(0, -1).map((lo, i) => {
        const hi = edges[i + 1];
        return {
            label: hi > 100 ? `${lo}–100%` : `${lo}–${hi}%`,
            above: lo >= threshold,
            count: people.filter((p) => p.best >= lo && p.best < hi).length
        };
    });

    return {
        ...raw,
        threshold,
        people,
        summary: {
            total: people.length,
            eligible: people.filter((p) => p.eligible).length,
            software: groupSummary('software'),
            powertrain: groupSummary('powertrain'),
            combo: {
                ...groupSummary('combo'),
                bothTracks: combo.filter((p) => p.eligibleTracks.length === 2).length,
                softwareOnly: combo.filter((p) => p.split && p.eligibleTracks[0] === 'software').length,
                powertrainOnly: combo.filter((p) => p.split && p.eligibleTracks[0] === 'powertrain').length,
                neither: combo.filter((p) => p.eligibleTracks.length === 0).length,
                eligibleWithAverageBelow: combo.filter((p) => p.eligible && p.average < threshold).length
            },
            distribution
        }
    };
}

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function AttendanceEligibility() {
    const [threshold, setThreshold] = useState(75);
    const [draft, setDraft] = useState('75');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [group, setGroup] = useState('all');
    const [view, setView] = useState('below');
    const [search, setSearch] = useState('');
    const [department, setDepartment] = useState('');
    const [sort, setSort] = useState('best');

    // Fetched once; the threshold is applied in the browser, so moving it is instant.
    const [raw, setRaw] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            setRaw(await fetchEligibility(75));
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const data = useMemo(() => (raw ? deriveAt(raw, threshold) : null), [raw, threshold]);

    const departments = useMemo(
        () => [...new Set((data?.people || []).map((p) => p.department).filter(Boolean))].sort(),
        [data]
    );

    const rows = useMemo(() => {
        if (!data) return [];
        const q = search.trim().toLowerCase();
        const list = data.people.filter((p) => {
            if (group !== 'all' && p.group !== group) return false;
            if (department && p.department !== department) return false;
            if (view === 'below' && p.eligible) return false;
            if (view === 'eligible' && !p.eligible) return false;
            if (view === 'split' && !p.split) return false;
            if (view === 'unreachable' && (p.eligible || p.canStillReach)) return false;
            if (q && !`${p.name} ${p.rollNo} ${p.email} ${p.phone}`.toLowerCase().includes(q)) return false;
            return true;
        });
        const sorters = {
            best: (a, b) => a.best - b.best,
            average: (a, b) => a.average - b.average,
            software: (a, b) =>
                (a.perTrack.software?.percentage ?? 999) - (b.perTrack.software?.percentage ?? 999),
            powertrain: (a, b) =>
                (a.perTrack.powertrain?.percentage ?? 999) - (b.perTrack.powertrain?.percentage ?? 999),
            streak: (a, b) =>
                Math.max(...Object.values(b.perTrack).map((r) => r.missedInARow)) -
                Math.max(...Object.values(a.perTrack).map((r) => r.missedInARow)),
            name: (a, b) => String(a.name).localeCompare(String(b.name))
        };
        return list.sort(sorters[sort]);
    }, [data, group, view, search, department, sort]);

    const setThresholdFrom = (value) => {
        setDraft(String(value));
        const n = Number(value);
        if (value !== '' && Number.isFinite(n) && n >= 1 && n <= 100) setThreshold(n);
    };

    const exportCsv = () => {
        const header = [
            'Name',
            'Roll No',
            'Department',
            'Year',
            'Group',
            'Phone',
            'Email',
            'Software %',
            'Software present',
            'Software conducted',
            'Powertrain %',
            'Powertrain present',
            'Powertrain conducted',
            'Average %',
            'Best track %',
            `Eligible (>= ${threshold}%)`,
            'Tracks cleared',
            'Can still reach',
            'Last seen'
        ];
        const lines = rows.map((p) => {
            const sw = p.perTrack.software;
            const pt = p.perTrack.powertrain;
            return [
                p.name,
                p.rollNo,
                p.department,
                p.year,
                p.group,
                p.phone,
                p.email,
                sw?.percentage ?? '',
                sw?.present ?? '',
                sw?.conducted ?? '',
                pt?.percentage ?? '',
                pt?.present ?? '',
                pt?.conducted ?? '',
                p.average,
                p.best,
                p.eligible ? 'Yes' : 'No',
                p.eligibleTracks.join(' + '),
                p.eligible ? '' : p.canStillReach ? 'Yes' : 'No',
                p.lastSeen || ''
            ]
                .map(csvCell)
                .join(',');
        });
        const blob = new Blob([[header.map(csvCell).join(','), ...lines].join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `attendance-eligibility-${group}-${view}-${threshold}pct.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    };

    const s = data?.summary;
    const maxBucket = s ? Math.max(1, ...s.distribution.map((b) => b.count)) : 1;

    return (
        <div className="space-y-4">
            {/* Threshold bar */}
            <div className="shadow-brutal-3 flex flex-col gap-3 border-2 border-slate-900 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-col gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                        <label className="font-black text-slate-700 uppercase">Eligibility threshold</label>
                        <input
                            type="number"
                            min="1"
                            max="100"
                            value={draft}
                            onChange={(e) => setThresholdFrom(e.target.value)}
                            onBlur={() => setDraft(String(threshold))}
                            className="w-20 border-2 border-slate-900 bg-white px-2 py-1 font-black"
                        />
                        <span className="font-black">%</span>
                        <button
                            type="button"
                            onClick={load}
                            className="press cursor-pointer border-2 border-slate-900 bg-white px-3 py-1 font-black uppercase"
                        >
                            {loading ? 'Loading…' : '↻ Refresh data'}
                        </button>
                    </div>
                    <input
                        type="range"
                        min="40"
                        max="100"
                        step="1"
                        value={threshold}
                        onChange={(e) => setThresholdFrom(e.target.value)}
                        className="w-full max-w-md accent-slate-900"
                        aria-label="Eligibility threshold"
                    />
                    <div className="flex flex-wrap gap-1.5">
                        {[50, 60, 65, 70, 75, 80, 85, 90].map((n) => (
                            <button
                                key={n}
                                type="button"
                                onClick={() => setThresholdFrom(n)}
                                className={`press cursor-pointer border-2 border-slate-900 px-2 py-0.5 text-[11px] font-black ${
                                    threshold === n ? 'bg-slate-900 text-white' : 'bg-white'
                                }`}
                            >
                                {n}%{data && n === data.certificateThreshold ? ' (cert rule)' : ''}
                            </button>
                        ))}
                    </div>
                </div>
                {data && (
                    <div className="text-[11px] font-bold text-slate-600">
                        Counted sessions so far: Software {data.conductedSessions.software} · Powertrain{' '}
                        {data.conductedSessions.powertrain}. Still scheduled: Software{' '}
                        {data.remainingSessions.software} · Powertrain {data.remainingSessions.powertrain}.
                        {data.certificateThreshold !== threshold && (
                            <span className="block text-amber-700">
                                Note: the certificate rule in student profiles is currently{' '}
                                {data.certificateThreshold}%.
                            </span>
                        )}
                    </div>
                )}
            </div>

            {error && (
                <div className="border-2 border-rose-600 bg-rose-50 p-3 text-xs font-bold text-rose-800">
                    {error}
                </div>
            )}

            {s && (
                <>
                    {/* Summary */}
                    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                        <Stat
                            label={`Eligible overall (≥ ${threshold}%)`}
                            value={`${s.eligible} / ${s.total}`}
                            sub={`${Math.round((s.eligible / Math.max(1, s.total)) * 100)}% of paid participants`}
                            tone="bg-emerald-100"
                        />
                        {['software', 'powertrain', 'combo'].map((g) => (
                            <Stat
                                key={g}
                                label={g === 'combo' ? 'Combo (either track)' : `${g} only`}
                                value={`${s[g].eligible} / ${s[g].total}`}
                                sub={`${s[g].below} below · ${s[g].cannotReach} can't reach anymore`}
                                tone={GROUP_STYLE[g].split(' ')[1]}
                            />
                        ))}
                    </div>

                    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                        <div className="border-2 border-slate-900 bg-white p-3">
                            <div className="mb-2 text-[10px] font-black tracking-wider text-violet-700 uppercase">
                                Combo participants, track by track (≥ {threshold}% on each)
                            </div>
                            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                                <Stat label="Both tracks" value={s.combo.bothTracks} />
                                <Stat label="Software only" value={s.combo.softwareOnly} tone="bg-sky-50" />
                                <Stat
                                    label="Powertrain only"
                                    value={s.combo.powertrainOnly}
                                    tone="bg-amber-50"
                                />
                                <Stat label="Neither" value={s.combo.neither} tone="bg-rose-50" />
                            </div>
                            <ul className="mt-2 space-y-0.5 text-[11px] font-bold text-slate-700">
                                <li>
                                    {s.combo.softwareOnly + s.combo.powertrainOnly} combo participants clear
                                    one track but not the other.
                                </li>
                                <li>
                                    {s.combo.eligibleWithAverageBelow} of the eligible combo participants have
                                    an average below {threshold}%.
                                </li>
                            </ul>
                        </div>

                        <div className="border-2 border-slate-900 bg-white p-3">
                            <div className="mb-2 text-[10px] font-black tracking-wider text-slate-700 uppercase">
                                Spread of attendance (better track for combo)
                            </div>
                            <div className="space-y-1">
                                {s.distribution.map((b) => (
                                    <div
                                        key={b.label}
                                        className="flex items-center gap-2 text-[11px] font-bold"
                                    >
                                        <span className="w-16 shrink-0 text-slate-600">{b.label}</span>
                                        <div className="h-4 flex-1 bg-slate-100">
                                            <div
                                                className={`h-4 ${b.above ? 'bg-emerald-600' : 'bg-rose-500'}`}
                                                style={{ width: `${(b.count / maxBucket) * 100}%` }}
                                            />
                                        </div>
                                        <span className="w-8 text-right">{b.count}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>

                    {/* Filters */}
                    <div className="flex flex-col gap-2 border-2 border-slate-900 bg-slate-50 p-3">
                        <div className="flex flex-wrap gap-1.5">
                            {GROUPS.map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => setGroup(id)}
                                    className={`press cursor-pointer border-2 border-slate-900 px-3 py-1 text-[11px] font-black uppercase ${
                                        group === id ? 'bg-slate-900 text-white' : 'bg-white'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                            <span className="mx-1 border-l-2 border-slate-300" />
                            {VIEWS.map(([id, label]) => (
                                <button
                                    key={id}
                                    type="button"
                                    onClick={() => setView(id)}
                                    className={`press cursor-pointer border-2 border-slate-900 px-3 py-1 text-[11px] font-black uppercase ${
                                        view === id ? 'bg-amber-300' : 'bg-white'
                                    }`}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                            <input
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder="Search name, roll no, phone, email"
                                className="min-w-0 flex-1 border-2 border-slate-900 bg-white px-2 py-1 font-bold"
                            />
                            <select
                                value={department}
                                onChange={(e) => setDepartment(e.target.value)}
                                className="max-w-full border-2 border-slate-900 bg-white px-2 py-1 font-bold"
                            >
                                <option value="">All departments</option>
                                {departments.map((d) => (
                                    <option key={d} value={d}>
                                        {d}
                                    </option>
                                ))}
                            </select>
                            <select
                                value={sort}
                                onChange={(e) => setSort(e.target.value)}
                                className="border-2 border-slate-900 bg-white px-2 py-1 font-bold"
                            >
                                <option value="best">Sort: lowest best track</option>
                                <option value="average">Sort: lowest average</option>
                                <option value="software">Sort: lowest software</option>
                                <option value="powertrain">Sort: lowest powertrain</option>
                                <option value="streak">Sort: most missed in a row</option>
                                <option value="name">Sort: name</option>
                            </select>
                            <button
                                type="button"
                                onClick={exportCsv}
                                disabled={!rows.length}
                                className="press cursor-pointer border-2 border-slate-900 bg-emerald-300 px-3 py-1 font-black uppercase disabled:opacity-40"
                            >
                                ⬇ CSV ({rows.length})
                            </button>
                        </div>
                    </div>

                    {/* List */}
                    <div className="overflow-x-auto border-2 border-slate-900 bg-white">
                        <table className="w-full min-w-[860px] text-left text-xs">
                            <thead className="bg-slate-900 text-[10px] tracking-wider text-white uppercase">
                                <tr>
                                    <th className="px-2 py-2">#</th>
                                    <th className="px-2 py-2">Participant</th>
                                    <th className="px-2 py-2">Dept · Yr</th>
                                    <th className="px-2 py-2">Group</th>
                                    <th className="px-2 py-2">Software</th>
                                    <th className="px-2 py-2">Powertrain</th>
                                    <th className="px-2 py-2">Average</th>
                                    <th className="px-2 py-2">Missed in a row</th>
                                    <th className="px-2 py-2">Last seen</th>
                                    <th className="px-2 py-2">Phone</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((p, i) => (
                                    <tr
                                        key={p.registrationId}
                                        className="border-t border-slate-200 align-top"
                                    >
                                        <td className="px-2 py-1.5 font-bold text-slate-400">{i + 1}</td>
                                        <td className="px-2 py-1.5">
                                            <div className="font-black text-slate-950">{p.name}</div>
                                            <div className="font-mono text-[10px] text-slate-500">
                                                {p.rollNo}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 text-[11px] text-slate-700">
                                            {p.department} · {p.year}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <span
                                                className={`border px-1.5 py-0.5 text-[10px] font-black uppercase ${GROUP_STYLE[p.group]}`}
                                            >
                                                {p.group}
                                            </span>
                                            {p.split && (
                                                <div className="mt-1 text-[10px] font-bold text-violet-700">
                                                    clears {p.eligibleTracks[0]} only
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <TrackCell row={p.perTrack.software} threshold={threshold} />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <TrackCell row={p.perTrack.powertrain} threshold={threshold} />
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <span className={`font-black ${pctTone(p.average, threshold)}`}>
                                                {p.average}%
                                            </span>
                                            <div className="text-[10px] font-bold">
                                                {p.eligible ? (
                                                    <span className="text-emerald-700">eligible</span>
                                                ) : p.canStillReach ? (
                                                    <span className="text-amber-700">can still reach</span>
                                                ) : (
                                                    <span className="text-rose-700">can't reach</span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-2 py-1.5 font-bold">
                                            {Math.max(
                                                ...Object.values(p.perTrack).map((r) => r.missedInARow)
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 font-bold text-slate-700">
                                            {p.neverAttended ? (
                                                <span className="text-rose-700">never</span>
                                            ) : (
                                                shortDate(p.lastSeen)
                                            )}
                                        </td>
                                        <td className="px-2 py-1.5 font-mono text-[11px]">
                                            {p.phone || '—'}
                                        </td>
                                    </tr>
                                ))}
                                {!rows.length && (
                                    <tr>
                                        <td
                                            colSpan={10}
                                            className="px-2 py-6 text-center font-bold text-slate-500"
                                        >
                                            Nobody matches these filters.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                    <p className="text-[11px] font-bold text-slate-500">
                        Percentages use the same session matching as student profiles: only sessions marked
                        conducted and counted. "Needs N in a row" is how many sessions they must attend back
                        to back to reach {threshold}%. "Max" is the best they can reach if they attend every
                        remaining scheduled session.
                    </p>
                </>
            )}
        </div>
    );
}
