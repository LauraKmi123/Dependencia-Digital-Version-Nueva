/*
 * Analítica agregada para Espejos Digitales.
 * - Con servidor Node/API disponible: usa las métricas compartidas del servidor.
 * - En GitHub Pages (sitio estático): usa un respaldo local del navegador. En ese modo
 *   los conteos se guardan solo en ese navegador/dispositivo, no se comparten entre visitantes.
 */
(() => {
    'use strict';

    const sectionIds = ['inicio', 'historia', 'relatos', 'podcast', 'recursos'];
    const labels = {
        inicio: 'Inicio',
        historia: 'Historia',
        relatos: 'Relatos',
        podcast: 'Podcast',
        recursos: 'Autodiagnóstico y Kit de Vida Digital Sana'
    };
    const sliceColors = ['#67e8f9', '#f9a8d4', '#a78bfa', '#fbbf24', '#34d399'];
    const sessionId = getSessionId();
    const seenKey = 'ed-analytics-seen';
    const localKey = 'ed-analytics-local-v1';
    const seen = new Set(readSessionArray(seenKey));
    const canvas = document.getElementById('visitor-analytics-chart');
    const legendContainer = document.getElementById('visitor-analytics-legend');
    const status = document.getElementById('analytics-status');
    const reactionStatus = document.getElementById('reaction-status');
    const reactionButtons = [...document.querySelectorAll('[data-reaction]')];
    const refreshEveryMs = 3000;
    let chart = null;
    let currentSection = null;
    let sectionStartedAt = 0;
    let serverAvailable = false;

    if (!canvas) return;

    function getSessionId() {
        try {
            let id = sessionStorage.getItem('ed-analytics-session');
            if (!id) {
                id = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
                sessionStorage.setItem('ed-analytics-session', id);
            }
            return id;
        } catch (_) {
            return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        }
    }

    function readSessionArray(key) {
        try {
            const value = JSON.parse(sessionStorage.getItem(key) || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_) { return []; }
    }

    function saveSessionValue(key, value) {
        try { sessionStorage.setItem(key, value); } catch (_) { /* almacenamiento opcional */ }
    }

    function readLocalData() {
        const emptySections = () => Object.fromEntries(sectionIds.map(id => [id, { views: 0, seconds: 0 }]));
        try {
            const parsed = JSON.parse(localStorage.getItem(localKey) || 'null');
            if (parsed && parsed.sections && parsed.days) {
                for (const id of sectionIds) parsed.sections[id] ||= { views: 0, seconds: 0 };
                return parsed;
            }
        } catch (_) { /* crear almacenamiento inicial */ }
        return { visits: 0, likes: 0, dislikes: 0, sections: emptySections(), days: {} };
    }

    function localDateKey() {
        try {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit'
            }).formatToParts(new Date());
            const obj = Object.fromEntries(parts.map(part => [part.type, part.value]));
            return `${obj.year}-${obj.month}-${obj.day}`;
        } catch (_) { return new Date().toISOString().slice(0, 10); }
    }

    function saveLocalData(data) {
        try { localStorage.setItem(localKey, JSON.stringify(data)); } catch (_) { /* si el navegador bloquea storage, la gráfica sigue funcionando */ }
    }

    function localBucket(data) {
        const date = localDateKey();
        if (!data.days[date]) {
            data.days[date] = {
                visits: 0, likes: 0, dislikes: 0,
                sections: Object.fromEntries(sectionIds.map(id => [id, { views: 0, seconds: 0 }]))
            };
        }
        return data.days[date];
    }

    function addLocalMetric(path, body) {
        const data = readLocalData();
        const day = localBucket(data);
        if (path === '/api/visit') {
            // Una visita por sesión de pestaña, para evitar sumar cada reintento.
            let counted = false;
            try { counted = sessionStorage.getItem('ed-analytics-local-visit') === '1'; } catch (_) { /* continúa */ }
            if (!counted) {
                data.visits += 1; day.visits += 1;
                saveSessionValue('ed-analytics-local-visit', '1');
            }
        } else if (path === '/api/section-view' && sectionIds.includes(body.section)) {
            data.sections[body.section].views += 1;
            day.sections[body.section].views += 1;
        } else if (path === '/api/section-time' && sectionIds.includes(body.section)) {
            const seconds = Math.max(0, Math.min(30, Number(body.seconds) || 0));
            data.sections[body.section].seconds += seconds;
            day.sections[body.section].seconds += seconds;
        } else if (path === '/api/reaction' && ['like', 'dislike'].includes(body.reaction)) {
            const key = body.reaction === 'like' ? 'likes' : 'dislikes';
            data[key] += 1; day[key] += 1;
        }
        saveLocalData(data);
        return data;
    }

    function localMetrics() {
        const data = readLocalData();
        const today = localBucket(data);
        saveLocalData(data);
        return {
            updatedAt: new Date().toISOString(),
            visits: data.visits,
            todayVisits: today.visits,
            likes: data.likes,
            dislikes: data.dislikes,
            sections: data.sections
        };
    }

    async function postMetric(path, body, useBeacon = false) {
        if (useBeacon && serverAvailable && navigator.sendBeacon) {
            navigator.sendBeacon(path, new Blob([JSON.stringify(body)], { type: 'application/json' }));
            return { ok: true, local: false };
        }
        try {
            const response = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                keepalive: true,
                cache: 'no-store'
            });
            if (response.ok) {
                serverAvailable = true;
                return { ok: true, local: false };
            }
        } catch (_) { /* GitHub Pages y otros hosts estáticos no exponen /api */ }
        serverAvailable = false;
        addLocalMetric(path, body);
        return { ok: true, local: true };
    }

    function setStatus(message, isError = false) {
        if (!status) return;
        status.textContent = message;
        status.classList.toggle('is-error', isError);
    }

    function sectionLabel(id) { return labels[id] || id; }

    const centerLabelsPlugin = {
        id: 'analyticsDonutLabels',
        afterDatasetsDraw(instance) {
            const values = instance.data.datasets[0]?.data || [];
            const visibleValues = values.map((value, index) => instance.getDataVisibility(index) ? (Number(value) || 0) : 0);
            const visibleTotal = visibleValues.reduce((sum, value) => sum + value, 0);
            const ctx = instance.ctx;
            const area = instance.chartArea;
            if (!area) return;
            const centerX = (area.left + area.right) / 2;
            const centerY = (area.top + area.bottom) / 2;

            if (!visibleTotal) {
                ctx.save();
                ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillStyle = '#f8fafc'; ctx.font = '700 13px Arial, sans-serif';
                ctx.fillText('Aún sin visitas', centerX, centerY - 7);
                ctx.fillStyle = '#ddd6fe'; ctx.font = '600 10px Arial, sans-serif';
                ctx.fillText('Los datos aparecerán aquí', centerX, centerY + 12);
                ctx.restore();
                return;
            }

            instance.getDatasetMeta(0).data.forEach((arc, index) => {
                const value = visibleValues[index];
                if (!value) return;
                const share = value / visibleTotal * 100;
                if (share < 7) return;
                const point = arc.getCenterPoint();
                ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillStyle = '#1e1038'; ctx.font = '700 12px Arial, sans-serif';
                ctx.fillText(`${Math.round(share)}%`, point.x, point.y); ctx.restore();
            });

            ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fff'; ctx.font = '700 23px Arial, sans-serif';
            ctx.fillText(visibleTotal.toLocaleString('es-CO'), centerX, centerY - 7);
            ctx.fillStyle = '#c4b5fd'; ctx.font = '700 9px Arial, sans-serif';
            ctx.fillText('VISTAS EN APARTADOS', centerX, centerY + 13); ctx.restore();
        }
    };

    function makeChartData(data = {}) {
        const sectionData = sectionIds.map(id => data.sections?.[id] || { views: 0 });
        return {
            labels: sectionIds.map(sectionLabel),
            datasets: [{
                data: sectionData.map(item => Math.max(0, Number(item.views) || 0)),
                backgroundColor: sliceColors,
                borderColor: '#32105b', borderWidth: 3,
                hoverBorderColor: '#fff', hoverBorderWidth: 2, hoverOffset: 9, spacing: 2
            }]
        };
    }

    function makeChartOptions() {
        return {
            font: { family: 'Arial, sans-serif', weight: '600' },
            responsive: true, maintainAspectRatio: false, cutout: '58%', radius: '92%',
            animation: { duration: 420 }, interaction: { mode: 'nearest', intersect: true }, layout: { padding: 8 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    enabled: true, backgroundColor: 'rgba(30, 10, 57, .97)', titleColor: '#fff', bodyColor: '#f8fafc',
                    borderColor: 'rgba(196, 181, 253, .4)', borderWidth: 1, padding: 12,
                    titleFont: { family: 'Arial, sans-serif', weight: '700', size: 13 },
                    bodyFont: { family: 'Arial, sans-serif', weight: '600', size: 12 },
                    callbacks: {
                        title(items) { return items[0]?.label || ''; },
                        label(context) {
                            const value = Number(context.parsed) || 0;
                            const allValues = context.chart.data.datasets[0].data;
                            const total = allValues.reduce((sum, item, index) => sum + (context.chart.getDataVisibility(index) ? (Number(item) || 0) : 0), 0);
                            return ` ${value.toLocaleString('es-CO')} vistas · ${(total ? value / total * 100 : 0).toFixed(1)}%`;
                        }
                    }
                }
            }
        };
    }

    function initializeChart() {
        if (typeof Chart === 'undefined') {
            setStatus('No se pudo cargar el gráfico. Comprueba que vendor/chart.min.js esté incluido.', true);
            return;
        }
        chart = new Chart(canvas, { type: 'doughnut', data: makeChartData(), options: makeChartOptions(), plugins: [centerLabelsPlugin] });
        renderChartLegend(localMetrics());
    }

    function renderChartLegend(data = {}) {
        if (!legendContainer) return;
        const items = sectionIds.map(id => ({ label: sectionLabel(id), views: Math.max(0, Number(data.sections?.[id]?.views) || 0) }));
        const visibleTotal = items.reduce((sum, item, index) => sum + ((chart?.getDataVisibility(index) ?? true) ? item.views : 0), 0);
        legendContainer.replaceChildren();
        items.forEach((item, index) => {
            const isVisible = chart?.getDataVisibility(index) ?? true;
            const share = isVisible && visibleTotal ? item.views / visibleTotal * 100 : 0;
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'analytics-chart-legend-item';
            button.setAttribute('aria-pressed', String(isVisible));
            button.setAttribute('aria-label', `${item.label}: ${item.views} vistas, ${share.toFixed(1)} por ciento. Tocar para mostrar u ocultar.`);
            const swatch = document.createElement('span'); swatch.className = 'analytics-chart-legend-swatch';
            swatch.style.backgroundColor = sliceColors[index]; swatch.setAttribute('aria-hidden', 'true');
            const name = document.createElement('span'); name.className = 'analytics-chart-legend-name'; name.textContent = item.label;
            const metrics = document.createElement('span'); metrics.className = 'analytics-chart-legend-metrics';
            const percentage = document.createElement('strong'); percentage.className = 'analytics-chart-legend-percent'; percentage.textContent = `${share.toFixed(1)}%`;
            const count = document.createElement('small'); count.textContent = `${item.views.toLocaleString('es-CO')} vistas`;
            metrics.append(percentage, count); button.append(swatch, name, metrics);
            button.addEventListener('click', () => {
                if (!chart) return;
                chart.toggleDataVisibility(index); chart.update(); renderChartLegend(data);
            });
            legendContainer.append(button);
        });
    }

    function updateChart(data) {
        if (!chart) return;
        chart.data = makeChartData(data);
        chart.update();
        renderChartLegend(data);
    }

    function updateSummary(data) {
        const totalVisits = document.getElementById('analytics-total-visits');
        const totalLikes = document.getElementById('analytics-total-likes');
        const totalDislikes = document.getElementById('analytics-total-dislikes');
        if (totalVisits) totalVisits.textContent = Number(data.todayVisits || 0).toLocaleString('es-CO');
        if (totalLikes) totalLikes.textContent = Number(data.likes || 0).toLocaleString('es-CO');
        if (totalDislikes) totalDislikes.textContent = Number(data.dislikes || 0).toLocaleString('es-CO');
    }

    async function loadMetrics() {
        try {
            const response = await fetch('/api/analytics', { cache: 'no-store' });
            if (!response.ok) throw new Error('API no disponible');
            const data = await response.json();
            if (!data || !data.sections) throw new Error('Respuesta de analítica inválida');
            serverAvailable = true;
            updateSummary(data); updateChart(data);
            const time = new Date(data.updatedAt || Date.now()).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            setStatus(`Servidor activo · Actualizado a las ${time} · Sincroniza cada 3 s.`);
        } catch (_) {
            serverAvailable = false;
            const data = localMetrics();
            updateSummary(data); updateChart(data);
            setStatus('Modo GitHub/estático: datos guardados solo en este navegador. Para estadísticas compartidas, conecta un servidor de analítica.');
        }
    }

    function reportSectionView(id) {
        if (seen.has(id)) return;
        seen.add(id); saveSessionValue(seenKey, JSON.stringify([...seen]));
        postMetric('/api/section-view', { sessionId, section: id }).then(loadMetrics);
    }

    function flushActiveTime(force = false, useBeacon = false) {
        if (!currentSection || !sectionStartedAt) return;
        const now = Date.now();
        if (document.hidden && !force) { sectionStartedAt = now; return; }
        const seconds = Math.min(30, Math.max(0, (now - sectionStartedAt) / 1000));
        sectionStartedAt = now;
        if (seconds < 1) return;
        postMetric('/api/section-time', { sessionId, section: currentSection, seconds: Math.round(seconds * 10) / 10 }, useBeacon).then(loadMetrics);
    }

    function setCurrentSection(id) {
        if (currentSection === id) return;
        if (currentSection) flushActiveTime();
        currentSection = id; sectionStartedAt = Date.now(); reportSectionView(id);
    }

    async function startTracking() {
        initializeChart();
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver(entries => {
                const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
                if (visible) setCurrentSection(visible.target.id);
            }, { threshold: [0.2, 0.4, 0.65] });
            sectionIds.forEach(id => { const section = document.getElementById(id); if (section) observer.observe(section); });
        } else if (document.getElementById('inicio')) setCurrentSection('inicio');

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flushActiveTime(true); else sectionStartedAt = Date.now();
        });
        window.addEventListener('pagehide', () => flushActiveTime(true, true));

        await postMetric('/api/visit', { sessionId });
        await loadMetrics();
        window.setInterval(() => {
            if (document.hidden) return;
            flushActiveTime(); loadMetrics();
        }, refreshEveryMs);
    }

    function initReactionButtons() {
        let savedReaction = null;
        try { savedReaction = sessionStorage.getItem('ed-analytics-reaction'); } catch (_) { /* opcional */ }
        if (savedReaction) setReaction(savedReaction, 'Gracias por compartir tu opinión. Tu reacción ya quedó registrada en esta visita.');

        reactionButtons.forEach(button => button.addEventListener('click', async () => {
            let alreadyVoted = false;
            try { alreadyVoted = Boolean(sessionStorage.getItem('ed-analytics-reaction')); } catch (_) { /* continúa */ }
            if (alreadyVoted) return;
            const choice = button.dataset.reaction;
            reactionButtons.forEach(item => { item.disabled = true; });
            const result = await postMetric('/api/reaction', { sessionId, reaction: choice });
            saveSessionValue('ed-analytics-reaction', choice);
            setReaction(choice, result.local
                ? '¡Gracias! Tu reacción quedó guardada en este navegador. En GitHub Pages no se comparte con otros visitantes.'
                : '¡Gracias! Tu reacción quedó registrada de forma anónima.');
            await loadMetrics();
        }));
    }

    function setReaction(choice, message) {
        reactionButtons.forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.reaction === choice));
            button.disabled = true;
        });
        if (reactionStatus) reactionStatus.textContent = message;
    }

    initReactionButtons();
    startTracking();
})();
