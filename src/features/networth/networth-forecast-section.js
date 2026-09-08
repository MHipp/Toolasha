/**
 * The Forecast section of the net worth history chart.
 *
 * A collapsed panel below the chart rather than another dataset on it: the
 * projection is in a different unit of confidence from the recorded history and
 * overlaying five speculative lines on the record makes the two look equally
 * measured.
 */

import { forecastNetworth, MIN_RETURNS } from './networth-forecast.js';
import { randomSeed } from '../combat-sim/engine/rng.js';
import { networthFormatter } from '../../utils/formatters.js';

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
const PLOT_HEIGHT = 160;

/**
 * Map a fan series to an SVG polyline `points` string.
 * @param {Array<number>} values - One value per day, day 0 first
 * @param {number} min - Lowest value across the whole fan
 * @param {number} max - Highest value across the whole fan
 * @returns {string} Points attribute
 */
function polylinePoints(values, min, max) {
    const span = max - min || 1;
    const lastIndex = Math.max(1, values.length - 1);
    return values
        .map((value, index) => {
            const x = (index / lastIndex) * PLOT_WIDTH;
            const y = PLOT_HEIGHT - ((value - min) / span) * PLOT_HEIGHT;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(' ');
}

/**
 * The fan as five SVG polylines.
 * @param {Object} forecast - A completed forecast
 * @returns {SVGElement} The plot
 */
function buildFanSvg(forecast) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'mwi-nw-forecast-fan');
    svg.style.cssText = 'width: 100%; height: 160px; display: block;';

    const all = FAN_LINES.flatMap((line) => forecast.fan[line.key]);
    const min = Math.min(...all);
    const max = Math.max(...all);

    for (const line of FAN_LINES) {
        const polyline = document.createElementNS(SVG_NS, 'polyline');
        polyline.setAttribute('points', polylinePoints(forecast.fan[line.key], min, max));
        polyline.setAttribute('fill', 'none');
        polyline.setAttribute('stroke', line.color);
        polyline.setAttribute('stroke-width', String(line.width));
        polyline.dataset.level = line.key;
        svg.appendChild(polyline);
    }

    return svg;
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
 * Percentage with one decimal, or an em dash when there is nothing to say.
 * @param {number|null} value - Percentage
 * @returns {string} Rendered figure
 */
function formatPercent(value) {
    return Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '—';
}

/**
 * Build the collapsed Forecast section.
 *
 * The projection is computed on first expand and on every control change, not
 * on open: it is thousands of paths, and the section is closed by default.
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
    const updateToggle = () => {
        toggle.textContent = `${expanded ? '▾' : '▸'} Forecast`;
    };
    updateToggle();

    /** Recompute and redraw. No-op while collapsed. */
    function refresh() {
        if (!expanded) return;
        plot.textContent = '';
        figures.textContent = '';

        const target = Number(String(targetInput.value).replace(/[,\s]/g, ''));
        const forecast = forecastNetworth(getHistory() || [], {
            days: Number(horizonSelect.value),
            target: Number.isFinite(target) && target > 0 ? target : null,
            seed,
        });

        if (forecast.status !== 'complete') {
            const message = document.createElement('div');
            message.className = 'mwi-nw-forecast-insufficient';
            message.textContent = `Not enough history to forecast — ${MIN_RETURNS} daily changes needed, ${forecast.returns} recorded.`;
            message.style.cssText = 'color: #888; font-size: 12px;';
            plot.appendChild(message);
            return;
        }

        plot.appendChild(buildFanSvg(forecast));

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
        figures.appendChild(buildFigure('Volatility (EWMA)', formatPercent(forecast.dailyVolatilityPercent)));
        figures.appendChild(buildFigure('Doubling', forecast.doublingDays ? `${forecast.doublingDays}d` : '—'));
        figures.appendChild(
            buildFigure('Method', forecast.method === 'gbm' ? 'GBM' : `Bootstrap (${forecast.returnCount} days)`)
        );

        for (const [checkpoint, chance] of Object.entries(forecast.probabilities)) {
            figures.appendChild(buildFigure(`Reach target by ${checkpoint}d`, `${chance.toFixed(1)}%`));
        }
    }

    toggle.addEventListener('click', () => {
        expanded = !expanded;
        body.hidden = !expanded;
        updateToggle();
        refresh();
    });
    horizonSelect.addEventListener('change', refresh);
    targetInput.addEventListener('change', refresh);

    element.appendChild(toggle);
    element.appendChild(body);

    return { element, refresh };
}
