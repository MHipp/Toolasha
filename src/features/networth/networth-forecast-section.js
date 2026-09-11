/**
 * The Forecast section of the net worth history chart.
 *
 * A collapsed panel below the chart rather than another dataset on it: the
 * projection is in a different unit of confidence from the recorded history and
 * overlaying five speculative lines on the record makes the two look equally
 * measured.
 */

import { forecastNetworth, reachProbabilities, MIN_RETURNS } from './networth-forecast.js';
import { randomSeed } from '../combat-sim/engine/rng.js';
import { formatDateTime, networthFormatter } from '../../utils/formatters.js';
import { isAmountText, parseItemCount } from '../../utils/number-parser.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Fan lines outside in: the extremes are faint, the median is the readable one. */
const FAN_LINES = [
    { key: 'p10', label: 'p10', color: '#64748b', width: 1 },
    { key: 'p25', label: 'p25', color: '#93c5fd', width: 1 },
    { key: 'p50', label: 'p50', color: '#f5c542', width: 2 },
    { key: 'p75', label: 'p75', color: '#93c5fd', width: 1 },
    { key: 'p90', label: 'p90', color: '#64748b', width: 1 },
];

const PLOT_WIDTH = 640;

/**
 * The plot's drawn height in CSS px. The SVG's viewBox is this tall too, so a
 * y in viewBox units is a y in px and the HTML labels beside it can be placed
 * without measuring anything.
 */
const PLOT_HEIGHT = 160;

/** Gutters in CSS px: value ticks left of the plot, line names right of it, days below. */
const VALUE_GUTTER = 52;
const LABEL_GUTTER = 88;
const DAY_GUTTER = 16;

/** One 11px label line; end labels closer together than this overlap. */
const LABEL_HEIGHT = 13;

/** Headroom above and below the fan so the outer lines do not sit on the frame. */
const DOMAIN_PADDING = 0.04;

/** Below this relative spread the fan is one line, and float noise must not be drawn as spread. */
const FLAT_TOLERANCE = 1e-6;

/** At most this many intervals along the day axis. */
const MAX_DAY_INTERVALS = 6;

/**
 * The value range the plot maps onto its height.
 * @param {Object} forecast - A completed forecast
 * @returns {{min: number, max: number}} Always a positive span
 */
export function fanDomain(forecast) {
    const values = FAN_LINES.flatMap((line) => forecast?.fan?.[line.key] ?? []).filter(Number.isFinite);
    if (values.length === 0) return { min: 0, max: 1 };
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min <= Math.abs(max) * FLAT_TOLERANCE) {
        const pad = Math.abs(max) * 0.01 || 1;
        return { min: min - pad, max: max + pad };
    }
    const pad = (max - min) * DOMAIN_PADDING;
    return { min: min - pad, max: max + pad };
}

/**
 * Round-numbered value ticks inside a range, 1/2/2.5/5 × a power of ten apart.
 * @param {number} min - Bottom of the range
 * @param {number} max - Top of the range
 * @param {number} [count] - Roughly how many ticks; never more than `count + 2`
 * @returns {Array<number>} Ascending tick values, empty for an unusable range
 */
export function valueTicks(min, max, count = 4) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) return [];
    const span = max - min;
    const magnitude = 10 ** Math.floor(Math.log10(span / (count + 1)));
    const step = [1, 2, 2.5, 5, 10].map((multiple) => multiple * magnitude).find((size) => span / size <= count + 1);
    const ticks = [];
    for (let index = Math.ceil(min / step); index * step <= max; index += 1) {
        ticks.push(Number((index * step).toPrecision(12)));
    }
    return ticks;
}

/**
 * Day ticks from 0 to the horizon, always ending on the horizon itself.
 * @param {number} horizon - Last projected day
 * @returns {Array<number>} Ascending days
 */
export function dayTicks(horizon) {
    const days = Math.floor(horizon);
    if (!(days >= 1)) return [0];
    const step =
        [1, 2, 5, 10, 15, 20, 30, 50, 60, 90, 100, 180, 365].find((size) => days / size <= MAX_DAY_INTERVALS) ??
        Math.ceil(days / MAX_DAY_INTERVALS);
    const ticks = [];
    for (let day = 0; day <= days; day += step) ticks.push(day);
    if (ticks.at(-1) !== days) {
        // A final tick crowding the horizon's would print on top of it
        if (days - ticks.at(-1) <= step / 2) ticks.pop();
        ticks.push(days);
    }
    return ticks;
}

/**
 * Vertical positions for the line-end labels.
 *
 * Every label sits level with its line when all of them clear each other.
 * When any two would overlap, only the required labels are kept — the
 * outermost lines and the median, which are the figures the stats row
 * reports — and those are pushed apart just far enough to read. Spreading all
 * five instead would leave labels far from the lines they name.
 *
 * @param {Array<{y: number, rank: number, required: boolean}>} entries - Line ends in px from the
 *   top; `rank` orders ties, higher percentile above
 * @param {number} [height] - Plot height in px
 * @param {number} [gap] - Minimum centre-to-centre distance in px
 * @returns {Array<Object>} The kept entries, top first, each with a `top` in px
 */
export function placeEndLabels(entries, height = PLOT_HEIGHT, gap = LABEL_HEIGHT) {
    const clamp = (y) => Math.min(height - gap / 2, Math.max(gap / 2, y));
    const placed = [...entries]
        .sort((a, b) => a.y - b.y || b.rank - a.rank)
        .map((entry) => ({ ...entry, top: clamp(entry.y) }));
    const clear = placed.every((entry, index) => index === 0 || entry.top - placed[index - 1].top >= gap);
    if (clear) return placed;

    const kept = placed.filter((entry) => entry.required);
    for (let index = 1; index < kept.length; index += 1) {
        kept[index].top = Math.max(kept[index].top, kept[index - 1].top + gap);
    }
    const last = kept.length - 1;
    if (last >= 0) kept[last].top = Math.min(kept[last].top, height - gap / 2);
    for (let index = last - 1; index >= 0; index -= 1) {
        kept[index].top = Math.min(kept[index].top, kept[index + 1].top - gap);
    }
    return kept;
}

/**
 * A value's y in the plot, in px from the top.
 * @param {number} value - Net worth
 * @param {{min: number, max: number}} domain - From {@link fanDomain}
 * @returns {number} y
 */
function valueToY(value, domain) {
    return PLOT_HEIGHT - ((value - domain.min) / (domain.max - domain.min)) * PLOT_HEIGHT;
}

/**
 * Map a fan series to an SVG polyline `points` string.
 * @param {Array<number>} values - One value per day, day 0 first
 * @param {{min: number, max: number}} domain - From {@link fanDomain}
 * @returns {string} Points attribute
 */
function polylinePoints(values, domain) {
    const lastIndex = Math.max(1, values.length - 1);
    return values
        .map((value, index) => {
            const x = (index / lastIndex) * PLOT_WIDTH;
            return `${x.toFixed(2)},${valueToY(value, domain).toFixed(2)}`;
        })
        .join(' ');
}

/**
 * An absolutely placed axis or line label.
 * @param {string} className - Label class
 * @param {string} text - Label text
 * @param {string} position - Extra CSS placing it
 * @returns {HTMLElement} The label
 */
function buildLabel(className, text, position) {
    const label = document.createElement('span');
    label.className = className;
    label.textContent = text;
    label.style.cssText = `position: absolute; white-space: nowrap; line-height: 1; ${position}`;
    return label;
}

/**
 * The fan with value ticks, day ticks and each line named at its right-hand end.
 *
 * Hand-drawn rather than a second Chart.js instance: the lines stretch with the
 * panel (`preserveAspectRatio="none"`), so text drawn inside the SVG would
 * stretch with them. Labels are HTML in fixed-width gutters around it, placed by
 * px vertically (the plot height is fixed) and by percent horizontally, so they
 * stay readable and inside the panel at any width. Styled after the main
 * chart's axes: `#999` ticks, `#333` grid, `networthFormatter` values.
 *
 * @param {Object} forecast - A completed forecast
 * @returns {HTMLElement} The plot and its labels
 */
export function buildFanPlot(forecast) {
    const domain = fanDomain(forecast);
    const horizon = Math.max(1, forecast.days ?? (forecast.fan?.[FAN_LINES[0].key]?.length ?? 2) - 1);

    const frame = document.createElement('div');
    frame.className = 'mwi-nw-forecast-plot-frame';
    frame.style.cssText = `
        display: grid;
        grid-template-columns: ${VALUE_GUTTER}px minmax(0, 1fr) ${LABEL_GUTTER}px;
        grid-template-rows: ${PLOT_HEIGHT}px ${DAY_GUTTER}px;
        font-size: 11px;
        color: #999;
    `;
    const cells = Array.from({ length: 6 }, () => {
        const cell = document.createElement('div');
        cell.style.cssText = 'position: relative; min-width: 0;';
        frame.appendChild(cell);
        return cell;
    });
    const [valueAxis, plotCell, labelCell, , dayAxis] = cells;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'mwi-nw-forecast-fan');
    svg.style.cssText = `width: 100%; height: ${PLOT_HEIGHT}px; display: block;`;

    const gridLine = (x1, y1, x2, y2) => {
        const line = document.createElementNS(SVG_NS, 'line');
        for (const [name, value] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(name, value.toFixed(2));
        line.setAttribute('stroke', '#333');
        line.setAttribute('stroke-width', '1');
        line.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(line);
    };

    // Two ticks the formatter prints alike (a narrow fan in the thousands) would read as a mislabel
    let previousText = null;
    for (const value of valueTicks(domain.min, domain.max)) {
        const text = networthFormatter(Math.round(value));
        if (text === previousText) continue;
        previousText = text;
        const y = valueToY(value, domain);
        gridLine(0, y, PLOT_WIDTH, y);
        valueAxis.appendChild(
            buildLabel('mwi-nw-forecast-y-tick', text, `right: 6px; top: ${y}px; transform: translateY(-50%);`)
        );
    }

    for (const day of dayTicks(horizon)) {
        const x = (day / horizon) * PLOT_WIDTH;
        gridLine(x, 0, x, PLOT_HEIGHT);
        dayAxis.appendChild(
            buildLabel(
                'mwi-nw-forecast-x-tick',
                `${day}d`,
                `left: ${(day / horizon) * 100}%; top: 3px; transform: translateX(-50%);`
            )
        );
    }

    const widest = Math.max(...FAN_LINES.map((line) => line.width));
    const ends = [];
    FAN_LINES.forEach((line, index) => {
        const values = forecast.fan?.[line.key] ?? [];
        const polyline = document.createElementNS(SVG_NS, 'polyline');
        polyline.setAttribute('points', polylinePoints(values, domain));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', line.color);
        polyline.setAttribute('stroke-width', String(line.width));
        polyline.setAttribute('vector-effect', 'non-scaling-stroke');
        polyline.dataset.level = line.key;
        svg.appendChild(polyline);

        const end = values.at(-1);
        if (!Number.isFinite(end)) return;
        ends.push({
            line,
            value: end,
            y: valueToY(end, domain),
            rank: index,
            required: index === 0 || index === FAN_LINES.length - 1 || line.width === widest,
        });
    });

    for (const entry of placeEndLabels(ends)) {
        const label = buildLabel(
            'mwi-nw-forecast-end-label',
            `${entry.line.label} ${networthFormatter(Math.round(entry.value))}`,
            `left: 6px; right: 0; top: ${entry.top}px; transform: translateY(-50%); overflow: hidden; ` +
                `text-overflow: ellipsis; color: ${entry.line.color};`
        );
        label.dataset.level = entry.line.key;
        labelCell.appendChild(label);
    }

    plotCell.appendChild(svg);
    return frame;
}

/**
 * One `label value` figure.
 * @param {string} label - Figure name
 * @param {string} value - Rendered value
 * @returns {HTMLElement} The figure
 */
function buildFigure(label, value) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display: flex; flex-direction: column; gap: 2px;';
    const name = document.createElement('span');
    name.textContent = label;
    name.style.cssText = 'color: #888; font-size: 11px;';
    const figure = document.createElement('span');
    figure.textContent = value;
    figure.style.cssText = 'color: #ddd; font-size: 13px;';
    wrap.appendChild(name);
    wrap.appendChild(figure);
    return wrap;
}

/**
 * Percentage with two decimals, or an em dash when there is nothing to say.
 * @param {number|null} value - Percentage
 * @param {boolean} [signed] - Mark non-negative values with "+"; off for a
 *   magnitude such as volatility, which has no direction to mark
 * @returns {string} Rendered figure
 */
function formatPercent(value, signed = true) {
    if (!Number.isFinite(value)) return '—';
    return `${signed && value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

/**
 * How the fan was drawn and from what: the generator, the number of changes
 * and the real dates they span, which with gaps reach further back than the
 * change count suggests.
 * @param {Object} forecast - A completed forecast
 * @returns {string} e.g. "Bootstrap (60 changes, 07-13 – 09-11)"
 */
export function methodLabel(forecast) {
    const name = forecast.method === 'gbm' ? 'GBM' : 'Bootstrap';
    const span = [forecast.windowStart, forecast.windowEnd].every(Number.isFinite)
        ? `, ${formatDateTime(new Date(forecast.windowStart), { includeTime: false })} – ${formatDateTime(new Date(forecast.windowEnd), { includeTime: false })}`
        : '';
    return `${name} (${forecast.returnCount} changes${span})`;
}

/**
 * Read the target box the way every other typed amount in Toolasha is read.
 *
 * Players write net worth as "12b" or "12 billion", not as eleven digits. The
 * box asks for an amount, so it is stricter than `parseItemCount` alone: text
 * with anything besides digits, separators and one magnitude suffix ("12xyz",
 * "12 bananas") is no target rather than 12.
 *
 * @param {string|null|undefined} text - What the player typed
 * @returns {number|null} A positive target, or null when there is none
 */
export function parseForecastTarget(text) {
    if (!isAmountText(text)) return null;
    const value = parseItemCount(String(text).trim(), NaN);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Build the collapsed Forecast section.
 *
 * The projection is computed on first expand and on every horizon change, not
 * on open: it is thousands of paths, and the section is closed by default. The
 * target never re-simulates; it reads its chances off the fan already drawn.
 *
 * @param {Object} options - Section options
 * @param {Function} options.getHistory - Returns the snapshot series to project
 * @param {number} [options.seed] - RNG seed; one is drawn per section so a
 *   re-render of the same inputs redraws the same fan
 * @returns {{element: HTMLElement, refresh: Function}} The section
 */
export function createForecastSection({ getHistory, seed = randomSeed() }) {
    const element = document.createElement('div');
    element.className = 'mwi-nw-forecast-section';
    element.style.cssText = 'margin-top: 10px; border-top: 1px solid #333; padding-top: 8px;';

    const toggle = document.createElement('button');
    toggle.className = 'mwi-nw-forecast-toggle';
    toggle.style.cssText = `
        background: none;
        border: none;
        color: #ccc;
        cursor: pointer;
        font-size: 13px;
        padding: 0;
    `;

    const body = document.createElement('div');
    body.className = 'mwi-nw-forecast-body';
    body.hidden = true;
    body.style.cssText = 'margin-top: 8px;';

    const controls = document.createElement('div');
    controls.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 8px;';

    const horizonSelect = document.createElement('select');
    horizonSelect.className = 'mwi-nw-forecast-horizon toolasha-select';
    horizonSelect.style.cssText =
        'background: #2a2a2a; color: #ccc; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 12px;';
    for (const days of [30, 60, 90]) {
        const option = document.createElement('option');
        option.value = String(days);
        option.textContent = `${days}d`;
        horizonSelect.appendChild(option);
    }
    horizonSelect.value = '30';

    const targetInput = document.createElement('input');
    targetInput.type = 'text';
    targetInput.className = 'mwi-nw-forecast-target';
    targetInput.placeholder = 'Target';
    targetInput.style.cssText =
        'background: #2a2a2a; color: #ccc; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 12px; width: 110px;';

    const horizonLabel = document.createElement('span');
    horizonLabel.textContent = 'Horizon:';
    horizonLabel.style.cssText = 'color: #888; font-size: 12px;';
    controls.appendChild(horizonLabel);
    controls.appendChild(horizonSelect);
    controls.appendChild(targetInput);

    const plot = document.createElement('div');
    plot.className = 'mwi-nw-forecast-plot';

    const figures = document.createElement('div');
    figures.className = 'mwi-nw-forecast-figures';
    figures.style.cssText = 'display: flex; flex-wrap: wrap; gap: 18px; margin-top: 8px;';

    body.appendChild(controls);
    body.appendChild(plot);
    body.appendChild(figures);

    let expanded = false;
    /** The forecast on screen, kept so a new target reads off its paths instead of simulating again. */
    let shown = null;
    /** The target figures on screen, replaced whenever the target changes. */
    let targetFigures = [];
    const updateToggle = () => {
        toggle.textContent = `${expanded ? '▾' : '▸'} Forecast`;
    };
    updateToggle();

    /** Redraw only the "Reach target by" figures for the target as typed. */
    function showTarget() {
        for (const node of targetFigures) node.remove();
        targetFigures = [];
        if (!expanded || shown?.status !== 'complete') return;
        const chances = reachProbabilities(shown, parseForecastTarget(targetInput.value));
        for (const [checkpoint, chance] of Object.entries(chances)) {
            const node = buildFigure(`Reach target by ${checkpoint}d`, `${chance.toFixed(1)}%`);
            figures.appendChild(node);
            targetFigures.push(node);
        }
    }

    /** Recompute and redraw. No-op while collapsed. */
    function refresh() {
        if (!expanded) return;
        plot.textContent = '';
        figures.textContent = '';
        targetFigures = [];
        shown = null;

        const forecast = forecastNetworth(getHistory() || [], { days: Number(horizonSelect.value), seed });

        if (forecast.status !== 'complete') {
            const message = document.createElement('div');
            message.className = 'mwi-nw-forecast-insufficient';
            message.textContent = `Not enough history to forecast — ${MIN_RETURNS} daily changes needed, ${forecast.returns} recorded.`;
            message.style.cssText = 'color: #888; font-size: 12px;';
            plot.appendChild(message);
            return;
        }

        plot.appendChild(buildFanPlot(forecast));

        figures.appendChild(
            buildFigure(`p50 day ${forecast.days}`, networthFormatter(Math.round(forecast.fan.p50.at(-1))))
        );
        figures.appendChild(
            buildFigure(
                `p10 – p90 day ${forecast.days}`,
                `${networthFormatter(Math.round(forecast.fan.p10.at(-1)))} – ${networthFormatter(Math.round(forecast.fan.p90.at(-1)))}`
            )
        );
        figures.appendChild(buildFigure('Daily drift', formatPercent(forecast.dailyDriftPercent)));
        figures.appendChild(buildFigure('Volatility (EWMA)', formatPercent(forecast.dailyVolatilityPercent, false)));
        figures.appendChild(buildFigure('Doubling', forecast.doublingDays ? `${forecast.doublingDays}d` : '—'));
        figures.appendChild(buildFigure('Method', methodLabel(forecast)));

        shown = forecast;
        showTarget();
    }

    toggle.addEventListener('click', () => {
        expanded = !expanded;
        body.hidden = !expanded;
        updateToggle();
        refresh();
    });
    horizonSelect.addEventListener('change', refresh);
    // Every keystroke, not only blur or Enter: a new target costs a binary search, not a simulation
    targetInput.addEventListener('input', showTarget);
    targetInput.addEventListener('change', showTarget);

    element.appendChild(toggle);
    element.appendChild(body);

    return { element, refresh };
}
