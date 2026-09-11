/**
 * Dungeon Tracker UI Chart Integration
 * Handles Chart.js rendering for dungeon run statistics
 */

import dungeonTrackerStorage, { filterRunsForCharacter, currentCharacter } from './dungeon-tracker-storage.js';
import { PANEL_Z_CAP } from '../../utils/panel-z-index.js';

class DungeonTrackerUIChart {
    constructor(state, formatTimeFunc) {
        this.state = state;
        this.formatTime = formatTimeFunc;
        this.chartInstance = null;
        this.modalChartInstance = null; // Store modal chart for cleanup
        this.closeModal = null; // Set while the pop-out modal is on the page
        // Set by dispose(), read by every render that resumes from an await.
        //
        // Not an init-ownership ticket: `stillOurs()` also fails when the
        // character moves, and a render interrupted by a switch that has not
        // yet torn the panel down must still finish — it draws the runs of the
        // character that asked into that character's still-live canvas, which
        // is what the identity fix settled. What a resumed render must never do
        // is build against a panel that has been taken down. That is a
        // teardown question only, and it is answered by the object being asked:
        // the parent builds a fresh section for the arriving character, so a
        // disposed section's tail is reading its own flag and can neither
        // overwrite nor destroy the new section's chart.
        this.disposed = false;
    }

    /**
     * Tear the section down: destroy both Chart.js instances and stop any
     * render still in flight from constructing another.
     *
     * Chart.js instances hold a resize observer, an animation loop and a slot
     * in Chart's own instance registry, so one built against the canvas of a
     * removed panel is never collected and never destroyed — one leak per
     * teardown that lands inside a render's storage read.
     * @returns {void}
     */
    dispose() {
        this.disposed = true;
        if (this.chartInstance) {
            this.chartInstance.destroy();
            this.chartInstance = null;
        }
        if (this.closeModal) {
            // Destroys modalChartInstance and takes the modal, and its
            // document-level ESC handler, off the page with it
            this.closeModal();
        }
        if (this.modalChartInstance) {
            this.modalChartInstance.destroy();
            this.modalChartInstance = null;
        }
    }

    /**
     * Render chart with filtered run data
     * @param {HTMLElement} container - Main container element
     */
    async render(container) {
        const canvas = container.querySelector('#mwi-dt-chart-canvas');
        if (!canvas) return;

        // Who the panel is speaking for, settled before the store is read: a
        // character switch landing inside that read used to move the answer,
        // and the chart drawn into the departing character's still-live canvas
        // plotted the arriving character's runs.
        const character = currentCharacter();

        // Get filtered runs based on current filters
        const allRuns = await dungeonTrackerStorage.getAllRuns();
        // A teardown landing inside that read has already destroyed this
        // section's chart and dropped the panel the canvas above belongs to.
        // Everything below draws: abandon it rather than build a Chart.js
        // instance nobody holds and nobody will ever destroy.
        if (this.disposed) return;
        // Narrowed to the character the panel is speaking for before anything
        // else, so the chart plots the same runs the list beneath it counts
        let filteredRuns = filterRunsForCharacter(allRuns, this.state.filterCharacter, character);

        if (this.state.filterDungeon !== 'all') {
            filteredRuns = filteredRuns.filter((r) => r.dungeonName === this.state.filterDungeon);
        }
        if (this.state.filterTeam !== 'all') {
            filteredRuns = filteredRuns.filter((r) => r.teamKey === this.state.filterTeam);
        }

        if (filteredRuns.length === 0) {
            // Destroy existing chart
            if (this.chartInstance) {
                this.chartInstance.destroy();
                this.chartInstance = null;
            }
            return;
        }

        // Sort by timestamp (oldest to newest)
        filteredRuns.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Prepare data
        // Label runs oldest to newest (Run 1 = oldest, Run N = most recent)
        const labels = filteredRuns.map((_, i) => `Run ${i + 1}`);
        const durations = filteredRuns.map((r) => (r.duration || r.totalTime || 0) / 60000); // Convert to minutes

        // Calculate stats
        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        const fastestDuration = Math.min(...durations);
        const slowestDuration = Math.max(...durations);

        // Create datasets
        const datasets = [
            {
                label: 'Run Times',
                data: durations,
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 5,
                tension: 0.1,
                fill: false,
            },
            {
                label: 'Average',
                data: new Array(durations.length).fill(avgDuration),
                borderColor: 'rgb(255, 159, 64)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
            {
                label: 'Fastest',
                data: new Array(durations.length).fill(fastestDuration),
                borderColor: 'rgb(75, 192, 75)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
            {
                label: 'Slowest',
                data: new Array(durations.length).fill(slowestDuration),
                borderColor: 'rgb(255, 99, 132)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
        ];

        // Destroy existing chart
        if (this.chartInstance) {
            this.chartInstance.destroy();
        }

        // Create new chart
        const ctx = canvas.getContext('2d');
        this.chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#ccc',
                            usePointStyle: true,
                            padding: 15,
                        },
                        onClick: (e, legendItem, legend) => {
                            const index = legendItem.datasetIndex;
                            const ci = legend.chart;
                            const meta = ci.getDatasetMeta(index);

                            // Toggle visibility
                            meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                            ci.update();
                        },
                    },
                    title: {
                        display: false,
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y;
                                const minutes = Math.floor(value);
                                const seconds = Math.floor((value - minutes) * 60);
                                return `${label}: ${minutes}m ${seconds}s`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Run Number',
                            color: '#ccc',
                        },
                        ticks: {
                            color: '#999',
                        },
                        grid: {
                            color: '#333',
                        },
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Duration (minutes)',
                            color: '#ccc',
                        },
                        ticks: {
                            color: '#999',
                        },
                        grid: {
                            color: '#333',
                        },
                        beginAtZero: false,
                    },
                },
            },
        });
    }

    /**
     * Create pop-out modal with larger chart
     */
    createPopoutModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('mwi-dt-chart-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // Create modal container
        const modal = document.createElement('div');
        modal.id = 'mwi-dt-chart-modal';
        modal.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            max-width: 1200px;
            height: 80%;
            max-height: 700px;
            background: #1a1a1a;
            border: 2px solid #555;
            border-radius: 8px;
            padding: 20px;
            z-index: ${PANEL_Z_CAP};
            display: flex;
            flex-direction: column;
        `;

        // Create header with close button
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        `;

        const title = document.createElement('h3');
        title.textContent = '📊 Dungeon Run Chart';
        title.style.cssText = 'color: #ccc; margin: 0; font-size: 18px;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: #a33;
            color: #fff;
            border: none;
            cursor: pointer;
            font-size: 20px;
            padding: 4px 12px;
            border-radius: 4px;
            font-weight: bold;
        `;
        const closeModal = () => {
            // Destroy chart before removing modal
            if (this.modalChartInstance) {
                this.modalChartInstance.destroy();
                this.modalChartInstance = null;
            }
            modal.remove();
            document.removeEventListener('keydown', escHandler);
            this.closeModal = null;
        };
        // Held so dispose() can take the modal down with the panel: it lives on
        // document.body rather than inside the container the teardown removes
        this.closeModal = closeModal;
        closeBtn.addEventListener('click', closeModal);

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Create canvas container
        const canvasContainer = document.createElement('div');
        canvasContainer.style.cssText = `
            flex: 1;
            position: relative;
            min-height: 0;
        `;

        const canvas = document.createElement('canvas');
        canvas.id = 'mwi-dt-chart-modal-canvas';
        canvasContainer.appendChild(canvas);

        modal.appendChild(header);
        modal.appendChild(canvasContainer);
        document.body.appendChild(modal);

        // Render chart in modal
        this.renderModalChart(canvas);

        // Close on ESC key (closeModal removes this listener on either close path)
        const escHandler = (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    /**
     * Render chart in pop-out modal
     * @param {HTMLElement} canvas - Canvas element
     */
    async renderModalChart(canvas) {
        // Settled before the read, for the same reason render() does it
        const character = currentCharacter();

        // Get filtered runs (same as main chart)
        const allRuns = await dungeonTrackerStorage.getAllRuns();
        // Same reason as render(): a section torn down inside the read must not
        // construct a chart the teardown has already gone past destroying
        if (this.disposed) return;
        // Narrowed to the character the panel is speaking for before anything
        // else, so the chart plots the same runs the list beneath it counts
        let filteredRuns = filterRunsForCharacter(allRuns, this.state.filterCharacter, character);

        if (this.state.filterDungeon !== 'all') {
            filteredRuns = filteredRuns.filter((r) => r.dungeonName === this.state.filterDungeon);
        }
        if (this.state.filterTeam !== 'all') {
            filteredRuns = filteredRuns.filter((r) => r.teamKey === this.state.filterTeam);
        }

        if (filteredRuns.length === 0) return;

        // Sort by timestamp
        filteredRuns.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Prepare data (same as main chart)
        // Label runs oldest to newest (Run 1 = oldest), matching the inline chart and run list
        const labels = filteredRuns.map((_, i) => `Run ${i + 1}`);
        const durations = filteredRuns.map((r) => (r.duration || r.totalTime || 0) / 60000);

        const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
        const fastestDuration = Math.min(...durations);
        const slowestDuration = Math.max(...durations);

        const datasets = [
            {
                label: 'Run Times',
                data: durations,
                borderColor: 'rgb(75, 192, 192)',
                backgroundColor: 'rgba(75, 192, 192, 0.2)',
                borderWidth: 2,
                pointRadius: 3,
                pointHoverRadius: 5,
                tension: 0.1,
                fill: false,
            },
            {
                label: 'Average',
                data: new Array(durations.length).fill(avgDuration),
                borderColor: 'rgb(255, 159, 64)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
            {
                label: 'Fastest',
                data: new Array(durations.length).fill(fastestDuration),
                borderColor: 'rgb(75, 192, 75)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
            {
                label: 'Slowest',
                data: new Array(durations.length).fill(slowestDuration),
                borderColor: 'rgb(255, 99, 132)',
                borderWidth: 2,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0,
                fill: false,
            },
        ];

        // Create chart
        const ctx = canvas.getContext('2d');
        this.modalChartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: datasets,
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            color: '#ccc',
                            usePointStyle: true,
                            padding: 15,
                            font: {
                                size: 14,
                            },
                        },
                        onClick: (e, legendItem, legend) => {
                            const index = legendItem.datasetIndex;
                            const ci = legend.chart;
                            const meta = ci.getDatasetMeta(index);

                            meta.hidden = meta.hidden === null ? !ci.data.datasets[index].hidden : null;
                            ci.update();
                        },
                    },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                const label = context.dataset.label || '';
                                const value = context.parsed.y;
                                const minutes = Math.floor(value);
                                const seconds = Math.floor((value - minutes) * 60);
                                return `${label}: ${minutes}m ${seconds}s`;
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Run Number',
                            color: '#ccc',
                            font: {
                                size: 14,
                            },
                        },
                        ticks: {
                            color: '#999',
                        },
                        grid: {
                            color: '#333',
                        },
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Duration (minutes)',
                            color: '#ccc',
                            font: {
                                size: 14,
                            },
                        },
                        ticks: {
                            color: '#999',
                        },
                        grid: {
                            color: '#333',
                        },
                        beginAtZero: false,
                    },
                },
            },
        });
    }
}

export default DungeonTrackerUIChart;
