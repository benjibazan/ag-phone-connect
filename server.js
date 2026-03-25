#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9000, 9001, 9002, 9003];
const POLL_INTERVAL = 1000; // 1 second
const SERVER_PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';
// Note: hashString is defined later, so we'll initialize the token inside createServer or use a simple string for now.
let AUTH_TOKEN = 'ag_default_token';


// Multi-window CDP state
// cdpConnection remains as a pointer to the ACTIVE window's connection (backward compat)
let cdpConnection = null;
let activeWindowId = null;
const cdpWindows = new Map(); // windowId -> { port, url, title, projectName, connection }
let lastSnapshot = null;
let lastSnapshotHash = null;

// Kill any existing process on the server port (prevents EADDRINUSE)
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            // Windows: Find PID using netstat and kill it
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            // Linux/macOS: Use lsof and kill
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p);
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
        // Small delay to let the port be released
        return new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
        // No process found on port - this is fine
        return Promise.resolve();
    }
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Find Antigravity CDP endpoint
async function discoverCDP() {
    const errors = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // Priority 1: Standard Workbench (The main window)
            const workbench = list.find(t => t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            if (workbench && workbench.webSocketDebuggerUrl) {
                console.log('Found Workbench target:', workbench.title);
                return { port, url: workbench.webSocketDebuggerUrl };
            }

            // Priority 2: Jetski/Launchpad (Fallback)
            const jetski = list.find(t => t.url?.includes('jetski') || t.title === 'Launchpad');
            if (jetski && jetski.webSocketDebuggerUrl) {
                console.log('Found Jetski/Launchpad target:', jetski.title);
                return { port, url: jetski.webSocketDebuggerUrl };
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`CDP not found. ${errorSummary}`);
}

// Extract project name from Antigravity window title
// e.g. "antigravity-chat - Antigravity - Walkthrough" → "antigravity-chat"
function extractProjectName(title) {
    if (!title) return 'Unknown';
    // Antigravity titles are: "project-name - Antigravity - TabName"
    const parts = title.split(' - ');
    if (parts.length >= 2) return parts[0].trim();
    return title.trim();
}

// Discover ALL Antigravity windows across all CDP ports
// Multiple windows can share the SAME port — each is a separate page target
async function discoverAllCDP() {
    const windows = [];
    let managerFound = false;
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);
            // Find ALL page targets that are workbench windows (not iframes, workers, etc.)
            const workbenches = list.filter(t =>
                t.type === 'page' &&
                t.webSocketDebuggerUrl &&
                (t.url?.includes('workbench.html') || t.title?.includes('Antigravity') || t.title === 'Launchpad')
            );
            for (const wb of workbenches) {
                const isManager = wb.title === 'Launchpad' || wb.title?.includes('Launchpad') || (wb.title?.includes('Manager') && !wb.title?.includes(' - '));
                // Skip duplicate Manager windows — only keep the first one
                if (isManager && managerFound) continue;
                if (isManager) managerFound = true;
                const projectName = isManager ? '⚡ Manager' : extractProjectName(wb.title);
                const windowId = `target-${wb.id || port + '-' + projectName}`;
                windows.push({
                    id: windowId,
                    port,
                    url: wb.webSocketDebuggerUrl,
                    title: wb.title,
                    projectName,
                    isManager
                });
            }
        } catch (e) { /* port not available */ }
    }
    // Sort: Manager first, then projects alphabetically
    windows.sort((a, b) => {
        if (a.isManager && !b.isManager) return -1;
        if (!a.isManager && b.isManager) return 1;
        return a.projectName.localeCompare(b.projectName);
    });
    return windows;
}

async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map(); // Track pending calls by ID
    const contexts = [];
    const CDP_CALL_TIMEOUT = 30000; // 30 seconds timeout

    // Single centralized message handler (fixes MaxListenersExceeded warning)
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);

                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;

        // Setup timeout to prevent memory leaks from never-resolved calls
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);

        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await call("Runtime.enable", {});
    await new Promise(r => setTimeout(r, 1000));

    return { ws, call, contexts };
}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    const CAPTURE_SCRIPT = `(() => {
        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) {
            // Debug info
            const body = document.body;
            const childIds = Array.from(body.children).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        // Find the main scrollable container
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // Clone cascade to modify it without affecting the original
        const clone = cascade.cloneNode(true);
        
        // Remove virtualization skeleton placeholders
        // Antigravity's UI replaces off-screen turns with empty gray skeleton divs
        // Pattern: <div style="height: Xpx;" class="rounded-lg bg-gray-500/10"></div>
        try {
            clone.querySelectorAll('[class*="bg-gray-500"]').forEach(el => {
                // Only remove if it looks like a skeleton (no meaningful child content)
                const hasContent = el.querySelector('p, li, h1, h2, h3, h4, h5, pre, code, span, a, img');
                if (!hasContent && (el.textContent || '').trim() === '') {
                    el.remove();
                }
            });
            // Also remove parent containers that are now empty after skeleton removal
            // These are the turn wrappers that only contained skeleton divs
            const turnWrappers = clone.querySelectorAll('.relative.flex.flex-col.gap-y-3 > div, .flex.flex-col.gap-y-3 > div');
            turnWrappers.forEach(wrapper => {
                if (wrapper.children.length === 0 && (wrapper.textContent || '').trim() === '') {
                    wrapper.remove();
                }
            });
        } catch(e) {}
        
        // Aggressively remove the entire interaction/input/review area
        try {
            // 1. Identify common interaction wrappers by class combinations
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        // For the editor, we want to remove its interaction container
                        if (selector === '[contenteditable="true"]') {
                            const area = el.closest('.relative.flex.flex-col.gap-8') || 
                                         el.closest('.flex.grow.flex-col.justify-start.gap-8') ||
                                         el.closest('div[id^="interaction"]') ||
                                         el.parentElement?.parentElement;
                            if (area && area !== clone) area.remove();
                            else el.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            // 2. Text-based cleanup for stray status bars and UI chrome
            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').trim().toLowerCase();
                    // Remove status bars
                    if (text.includes('review changes') || text.includes('files with changes') || text.includes('context found')) {
                        if (el.children.length < 10 || el.querySelector('button') || el.classList?.contains('justify-between')) {
                            el.remove();
                            return;
                        }
                    }
                    // Remove Relocate/Always run buttons and small UI chrome
                    if (text === 'relocate' || text === 'always run' || text === 'exit code' || text === 'open' || text === 'proceed') {
                        if (el.tagName === 'BUTTON' || el.closest('button') || (el.offsetWidth < 200 && el.offsetHeight < 60)) {
                            const target = el.closest('button') || el;
                            target.remove();
                            return;
                        }
                    }
                } catch (e) {}
            });
            
            // 2b. Remove tooltip containers, floating UI, badges
            const uiJunkSelectors = [
                '[data-tooltip-id]',
                '[role="tooltip"]',
                '.tooltip',
                '[class*="tooltip"]',
                '[class*="popover"]',
                '[class*="overlay"]',
                '[class*="floating"]',
                '[class*="badge"]',
                '[class*="chip"]',
                'button[class*="relocate" i]',
            ];
            uiJunkSelectors.forEach(sel => {
                try { clone.querySelectorAll(sel).forEach(el => el.remove()); } catch(e) {}
            });
            
            // 2c. Remove positioned overlays that use Tailwind-style CSS classes
            // These are UI chrome that float on top of actual content
            const positionedOverlaySelectors = [
                '.absolute.top-0',
                '.absolute.bottom-0',
                '.absolute.right-0',
                '.absolute.left-0',
                '.fixed',
                '.sticky',
            ];
            positionedOverlaySelectors.forEach(sel => {
                try { 
                    clone.querySelectorAll(sel).forEach(el => {
                        // Only remove if it's small (likely a button/badge) or not a content container
                        const childCount = el.querySelectorAll('p, li, h1, h2, h3, h4, h5, pre, code').length;
                        if (childCount === 0) {
                            el.remove();
                        }
                    }); 
                } catch(e) {}
            });
            
            // 2d. Remove oversized SVGs and all SVGs that aren't inline small icons
            clone.querySelectorAll('svg').forEach(svg => {
                try {
                    const w = svg.getAttribute('width') || svg.style.width || '';
                    const h = svg.getAttribute('height') || svg.style.height || '';
                    const wNum = parseInt(w);
                    const hNum = parseInt(h);
                    // Remove SVGs larger than 100px or without any dimensions (will be blown up)
                    if ((wNum > 100 || hNum > 100) || (!w && !h)) {
                        // Keep small inline SVGs (likely icons within text)
                        if (svg.closest('p') || svg.closest('li') || svg.closest('span')) {
                            return; // Keep inline icons
                        }
                        svg.remove();
                    }
                } catch(e) {}
            });

        } catch (globalErr) { }
        
        // 3. Remove any remaining contenteditable areas (input boxes with leftover text)
        try {
            clone.querySelectorAll('[contenteditable="true"]').forEach(el => {
                // Walk up to find the turn/interaction container and remove it
                let container = el;
                for (let i = 0; i < 5; i++) {
                    if (!container.parentElement || container.parentElement === clone) break;
                    container = container.parentElement;
                }
                if (container && container !== clone) container.remove();
            });
        } catch (e) {}
        
        const html = clone.outerHTML;
        
        const rules = [];
        for (const sheet of document.styleSheets) {
            try {
                for (const rule of sheet.cssRules) {
                    rules.push(rule.cssText);
                }
            } catch (e) { }
        }
        const allCSS = rules.join('\\n');
        
        return {
            html: html,
            css: allCSS,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length,
                cssSize: allCSS.length
            }
        };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            // console.log(`Trying context ${ctx.id} (${ctx.name || ctx.origin})...`);
            const result = await cdp.call("Runtime.evaluate", {
                expression: CAPTURE_SCRIPT,
                returnByValue: true,
                contextId: ctx.id
            });

            if (result.exceptionDetails) {
                // console.log(`Context ${ctx.id} exception:`, result.exceptionDetails);
                continue;
            }

            if (result.result && result.result.value) {
                const val = result.result.value;
                if (val.error) {
                    // console.log(`Context ${ctx.id} script error:`, val.error);
                    // if (val.debug) console.log(`   Debug info:`, JSON.stringify(val.debug));
                } else {
                    return val;
                }
            }
        } catch (e) {
            console.log(`Context ${ctx.id} connection error:`, e.message);
        }
    }

    return null;
}

// Inject message into Antigravity
async function injectMessage(cdp, text) {
    // Use JSON.stringify for robust escaping (handles ", \, newlines, backticks, unicode, etc.)
    const safeText = JSON.stringify(text);

    const EXPRESSION = `(async () => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) return { ok:false, reason:"busy" };

        const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
            .filter(el => el.offsetParent !== null);
        const editor = editors.at(-1);
        if (!editor) return { ok:false, error:"editor_not_found" };

        const textToInsert = ${safeText};

        editor.focus();
        document.execCommand?.("selectAll", false, null);
        document.execCommand?.("delete", false, null);

        let inserted = false;
        try { inserted = !!document.execCommand?.("insertText", false, textToInsert); } catch {}
        if (!inserted) {
            editor.textContent = textToInsert;
            editor.dispatchEvent(new InputEvent("beforeinput", { bubbles:true, inputType:"insertText", data: textToInsert }));
            editor.dispatchEvent(new InputEvent("input", { bubbles:true, inputType:"insertText", data: textToInsert }));
        }

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

        const submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
        if (submit && !submit.disabled) {
            submit.click();
            // Clear editor text after submit to prevent it lingering in snapshots
            await new Promise(r => setTimeout(r, 200));
            try { editor.textContent = ''; } catch(e) {}
            return { ok:true, method:"click_submit" };
        }

        // Submit button not found, but text is inserted - trigger Enter key
        editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles:true, key:"Enter", code:"Enter" }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { bubbles:true, key:"Enter", code:"Enter" }));
        
        return { ok:true, method:"enter_keypress" };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const result = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });

            if (result.result && result.result.value) {
                return result.result.value;
            }
        } catch (e) { }
    }

    return { ok: false, reason: "no_context" };
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation
async function stopGeneration(cdp) {
    const EXP = `(async () => {
        // Look for the cancel button
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            return { success: true };
        }
        
        // Fallback: Look for a square icon in the send button area
        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
        if (stopBtn && stopBtn.offsetParent !== null) {
            stopBtn.click();
            return { success: true, method: 'fallback_square' };
        }

        return { error: 'No active generation found to stop' };
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const safeSelector = JSON.stringify(selector || '');
    const safeTextContent = JSON.stringify(textContent || '');
    const safeIndex = Number.isInteger(index) ? index : 0;

    const EXP = `(async () => {
        try {
            // Strategy: Find all elements matching the selector
            // If textContent is provided, filter by that too for safety
            let elements = Array.from(document.querySelectorAll(${safeSelector}));
            
            const filterText = ${safeTextContent};
            if (filterText) {
                elements = elements.filter(el => el.textContent.includes(filterText));
            }

            const target = elements[${safeIndex}];

            if (target) {
                target.click();
                return { success: true };
            }
            
            return { error: 'Element not found at index ${safeIndex}' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts' };
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-tooltip-id patterns (most reliable)
            modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Start New Chat - Click the + button at the TOP of the chat window (NOT the context/media + button)
async function startNewChat(cdp) {
    const EXP = `(async () => {
        try {
            // Priority 1: Exact selector from user (data-tooltip-id="new-conversation-tooltip")
            const exactBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (exactBtn) {
                exactBtn.click();
                return { success: true, method: 'data-tooltip-id' };
            }

            // Fallback: Use previous heuristics
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            
            // Find all buttons with plus icons
            const plusButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false; // Skip hidden
                const hasPlusIcon = btn.querySelector('svg.lucide-plus') || 
                                   btn.querySelector('svg.lucide-square-plus') ||
                                   btn.querySelector('svg[class*="plus"]');
                return hasPlusIcon;
            });
            
            // Filter only top buttons (toolbar area)
            const topPlusButtons = plusButtons.filter(btn => {
                const rect = btn.getBoundingClientRect();
                return rect.top < 200;
            });

            if (topPlusButtons.length > 0) {
                 topPlusButtons.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
                 topPlusButtons[0].click();
                 return { success: true, method: 'filtered_top_plus', count: topPlusButtons.length };
            }
            
            // Fallback: aria-label
             const newChatBtn = allButtons.find(btn => {
                const ariaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
                const title = btn.getAttribute('title')?.toLowerCase() || '';
                return (ariaLabel.includes('new') || title.includes('new')) && btn.offsetParent !== null;
            });
            
            if (newChatBtn) {
                newChatBtn.click();
                return { success: true, method: 'aria_label_new' };
            }
            
            return { error: 'New chat button not found' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}
// Get Chat History - Click history button via CDP native click and scrape conversations
async function getChatHistory(cdp) {
    const debugSteps = [];

    // Phase 1: Find the history button coordinates via JS eval
    const FIND_BTN = `(() => {
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                                   btn.querySelector('svg.lucide-history') ||
                                   btn.querySelector('svg.lucide-clock-rotate-left') ||
                                   btn.querySelector('svg[class*="history"]');
            if (hasHistoryIcon) {
                const rect = btn.getBoundingClientRect();
                return { found: true, method: 'icon', x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
            }
        }
        // Fallback: tooltip ID
        const tooltipBtn = document.querySelector('[data-tooltip-id*="conversation-history"], [data-tooltip-id*="history"]');
        if (tooltipBtn) {
            const rect = tooltipBtn.getBoundingClientRect();
            return { found: true, method: 'tooltip', x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
        }
        return { found: false };
    })()`;

    let btnCoords = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: FIND_BTN, returnByValue: true, contextId: ctx.id
            });
            if (res.result?.value?.found) {
                btnCoords = res.result.value;
                debugSteps.push(`btn: ${btnCoords.method} (${Math.round(btnCoords.x)},${Math.round(btnCoords.y)})`);
                break;
            }
        } catch (e) { }
    }

    if (!btnCoords) {
        return { error: 'History button not found', chats: [], debug: { steps: debugSteps } };
    }

    // Phase 2: CDP native click at button coordinates (bypasses React synthetic event issues)
    try {
        const x = Math.round(btnCoords.x);
        const y = Math.round(btnCoords.y);
        await cdp.call("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await cdp.call("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        debugSteps.push('CDP native click OK');
    } catch (e) {
        debugSteps.push('CDP click error: ' + e.message);
    }

    // Wait for dialog to open
    await new Promise(r => setTimeout(r, 2500));

    // Phase 3: Scrape the conversation dialog
    const SCRAPE = `(async () => {
        const chats = [];
        const seenTitles = new Set();
        let panel = null;
        
        // Find dialog: search input or anchor text
        let searchInput = Array.from(document.querySelectorAll('input')).find(i => {
            const ph = (i.placeholder || '').toLowerCase();
            return ph.includes('select') || ph.includes('conversation') || ph.includes('search');
        });
        
        let anchorElement = null;
        if (!searchInput) {
            anchorElement = Array.from(document.querySelectorAll('span, div, p, h2, h3')).find(s => {
                const t = (s.innerText || '').trim().toLowerCase();
                return t === 'current' || t === 'other conversations' || t === 'select a conversation';
            });
        }
        
        // Role-based panel search  
        if (!searchInput && !anchorElement) {
            const panels = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [data-state="open"], [class*="popover"]'));
            for (const p of panels) {
                if (p.offsetParent === null) continue;
                const rect = p.getBoundingClientRect();
                if (rect.width > 200 && rect.height > 200) { panel = p; break; }
            }
        }
        
        // Overlay search — reject model selector
        if (!searchInput && !anchorElement && !panel) {
            const candidates = [];
            for (const el of Array.from(document.querySelectorAll('*'))) {
                const style = window.getComputedStyle(el);
                const rect = el.getBoundingClientRect();
                if ((style.position === 'fixed' || style.position === 'absolute') && 
                    parseInt(style.zIndex) > 5 && rect.width > 150 && rect.height > 200 &&
                    el.querySelectorAll('span, div, a, p').length > 3) {
                    const text = (el.textContent || '').toLowerCase();
                    const isConv = text.includes('current') || text.includes('recent in') || text.includes('other conversations');
                    const isModel = rect.width < 300 && (text.includes('gemini') || text.includes('claude') || text.includes('gpt'));
                    candidates.push({ el, area: rect.width * rect.height, isConv, isModel });
                }
            }
            const best = candidates.find(c => c.isConv) || candidates.find(c => !c.isModel);
            if (best) panel = best.el;
        }
        
        // Walk up from anchor/input to find panel
        const startElement = searchInput || anchorElement;
        if (startElement && !panel) {
            let container = startElement;
            for (let i = 0; i < 15; i++) {
                if (!container.parentElement) break;
                container = container.parentElement;
                const rect = container.getBoundingClientRect();
                if (rect.width > 50 && rect.height > 100) {
                    panel = container;
                    const style = window.getComputedStyle(container);
                    if (style.position === 'fixed' || style.position === 'absolute') break;
                }
            }
        }
        
        const debugInfo = { 
            panelFound: !!panel, panelWidth: panel?.offsetWidth || 0, panelHeight: panel?.offsetHeight || 0,
            inputFound: !!searchInput, anchorFound: !!anchorElement, anchorText: anchorElement?.innerText?.trim() || null
        };
        
        if (panel) {
            const elements = Array.from(panel.querySelectorAll('span, div, p, a'));
            const SKIP_EXACT = new Set([
                'current', 'other conversations', 'now', 'today', 'yesterday', 'previous', 'older',
                'this week', 'last week', 'this month', 'last month', 'search', 'filter', 'conversations',
                'history', 'new conversation', 'new chat', 'close', 'recent', 'chat history',
                'select a conversation', 'no conversations', 'start a new conversation', 'start new conversation',
                'pinned', 'all conversations', 'delete', 'rename', 'archive', 'model', 'show more...'
            ]);
            const MODEL_PATTERN = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\\b/i;
            
            for (const el of elements) {
                const text = el.textContent?.trim() || '';
                const lower = text.toLowerCase();
                if (text.length < 3 || text.length > 100) continue;
                if (SKIP_EXACT.has(lower)) continue;
                if (lower.startsWith('recent in ') || lower.startsWith('blocked on ')) continue;
                if (lower.startsWith('show ') && lower.includes('more')) continue;
                if (lower.endsWith(' ago') || /^\\d+\\s*(sec|min|hr|hour|day)/i.test(lower)) continue;
                if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(lower) && text.length < 20) continue;
                if (MODEL_PATTERN.test(text)) continue;
                if (el.children.length > 3) continue;
                if (seenTitles.has(text)) continue;
                
                seenTitles.add(text);
                chats.push({ title: text, date: 'Recent' });
                if (chats.length >= 50) break;
            }
        }
        
        // Close dialog
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        
        // Raw texts debug
        const rawTexts = [];
        if (panel) {
            for (const el of Array.from(panel.querySelectorAll('span, div, p, a'))) {
                const t = (el.textContent || '').trim();
                if (t.length >= 3 && t.length <= 80 && el.children.length <= 3 && !rawTexts.includes(t)) {
                    rawTexts.push(t);
                    if (rawTexts.length >= 15) break;
                }
            }
        }
        
        return { success: true, chats, debug: debugInfo, totalScraped: chats.length, rawTexts };
    })()`;

    let lastError = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: SCRAPE, returnByValue: true, awaitPromise: true, contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                val.debug = { ...val.debug, steps: debugSteps };
                console.log(`📋 Chat history: ${val.chats?.length || 0} conversations (steps: ${debugSteps.join(' → ')})`);
                if (val.chats?.length > 0 || val.debug?.panelFound) return val;
                lastError = 'No chats in ctx ' + ctx.id;
            }
            if (res.exceptionDetails) {
                lastError = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
            }
        } catch (e) { lastError = e.message; }
    }
    return { error: 'Context failed: ' + (lastError || 'No contexts'), chats: [] };
}





async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);

    const EXP = `(async () => {
    try {
        const targetTitle = ${safeChatTitle};

        // First, we need to open the history panel
        // Priority 1: Find by icon type (most reliable for Antigravity)
        let historyBtn = null;
        {
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"], a'));
            for (const btn of allButtons) {
                if (btn.offsetParent === null) continue;
                const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                    btn.querySelector('svg.lucide-history') ||
                    btn.querySelector('svg.lucide-clock-rotate-left') ||
                    btn.querySelector('svg[class*="history"]');
                if (hasHistoryIcon) {
                    historyBtn = btn;
                    break;
                }
            }
        }

        // Priority 2: Adjacent to new chat button
        if (!historyBtn) {
            const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
            if (newChatBtn) {
                const parent = newChatBtn.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children).filter(el => el !== newChatBtn);
                    historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
                }
            }
        }

        // Priority 3: Tooltip ID fallback
        if (!historyBtn) {
            historyBtn = document.querySelector('[data-tooltip-id*="conversation-history"], [data-tooltip-id*="history"], [data-tooltip-id*="past"]');
        }

        // Fallback: Find by position (second button at top)
        if (!historyBtn) {
            const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
            const topButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false;
                const rect = btn.getBoundingClientRect();
                return rect.top < 100 && rect.top > 0;
            }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

            if (topButtons.length >= 2) {
                historyBtn = topButtons[1];
            }
        }

        if (historyBtn) {
            historyBtn.click();
            await new Promise(r => setTimeout(r, 1500));
        }

        // Now find the chat by title in the opened panel
        await new Promise(r => setTimeout(r, 500));

        // Search in span, div, p, a elements (not all elements)
        const searchElements = Array.from(document.querySelectorAll('span, div, p, a'));

        // Find elements matching the title
        const candidates = searchElements.filter(el => {
            if (el.offsetParent === null) return false;
            if (el.children.length > 5) return false;
            const text = el.innerText?.trim();
            if (!text) return false;
            // Match by prefix (first 30 chars) to handle truncation
            return text.startsWith(targetTitle.substring(0, Math.min(30, targetTitle.length))) ||
                targetTitle.startsWith(text.substring(0, Math.min(30, text.length)));
        });

        // Find the most specific (deepest) visible element with the title
        let target = null;
        let maxDepth = -1;

        for (const el of candidates) {
            if (el.children.length > 5) continue;

            let depth = 0;
            let parent = el;
            while (parent) {
                depth++;
                parent = parent.parentElement;
            }

            if (depth > maxDepth) {
                maxDepth = depth;
                target = el;
            }
        }

        if (target) {
            // Find clickable parent if needed
            let clickable = target;
            for (let i = 0; i < 5; i++) {
                if (!clickable) break;
                const style = window.getComputedStyle(clickable);
                if (style.cursor === 'pointer' || clickable.tagName === 'BUTTON' || clickable.tagName === 'A') {
                    break;
                }
                clickable = clickable.parentElement;
            }

            if (clickable) {
                clickable.click();
                return { success: true, method: 'clickable_parent' };
            }

            target.click();
            return { success: true, method: 'direct_click' };
        }

        return { error: 'Chat not found: ' + targetTitle };
    } catch (e) {
        return { error: e.toString() };
    }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
    const hasMessages = chatContainer && chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0;
    return {
        hasChat: !!chatContainer,
        hasMessages: hasMessages,
        editorFound: !!(chatContainer && chatContainer.querySelector('[data-lexical-editor="true"]'))
    };
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { hasChat: false, hasMessages: false, editorFound: false };
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for button containing a known model keyword
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
        const modelEl = textNodes.find(el => {
            const txt = el.innerText;
            // Avoids "Select Model" placeholder if possible, but usually a model is selected
            return KNOWN_MODELS.some(k => txt.includes(k)) &&
                // Check if it's near a chevron (likely values in the header)
                el.closest('button')?.querySelector('svg.lucide-chevron-up');
        });

        if (modelEl) {
            state.model = modelEl.innerText.trim();
        }

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Check if an IP is in the 172.16.0.0 - 172.31.255.255 private range
function isPrivate172(ip) {
    const match = ip.match(/(?:^|::ffff:)(172\.(\d+)\.)/)
    if (!match) return false;
    const second = parseInt(match[2], 10);
    return second >= 16 && second <= 31;
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges + Tailscale CGNAT (100.64.0.0/10)
    const isTailscale = (() => {
        const match = ip.match(/(?:^|::ffff:)(100\.(\d+)\.)/);
        if (!match) return false;
        const second = parseInt(match[2], 10);
        return second >= 64 && second <= 127; // 100.64.0.0/10
    })();

    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        isPrivate172(ip) ||
        isTailscale ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

// Initialize CDP connection(s) — discovers all Antigravity windows
async function initCDP() {
    console.log('🔍 Discovering Antigravity CDP endpoints...');
    const windows = await discoverAllCDP();

    if (windows.length === 0) {
        // Fallback to classic single-window discovery
        const cdpInfo = await discoverCDP();
        const conn = await connectCDP(cdpInfo.url);
        const windowId = `window-${cdpInfo.port}`;
        cdpWindows.set(windowId, {
            port: cdpInfo.port, url: cdpInfo.url, title: 'Antigravity',
            projectName: 'Unknown', connection: conn
        });
        activeWindowId = windowId;
        cdpConnection = conn;
        console.log(`✅ Connected to 1 window on port ${cdpInfo.port}\n`);
        return;
    }

    console.log(`🪟 Found ${windows.length} Antigravity window(s)`);

    for (const win of windows) {
        // Skip if already connected to this window
        if (cdpWindows.has(win.id) && cdpWindows.get(win.id).connection?.ws?.readyState === WebSocket.OPEN) {
            console.log(`  ✅ ${win.projectName} (port ${win.port}) — already connected`);
            continue;
        }
        try {
            const conn = await connectCDP(win.url);
            cdpWindows.set(win.id, { ...win, connection: conn });
            console.log(`  🔌 ${win.projectName} (port ${win.port}) — connected, ${conn.contexts.length} contexts`);
        } catch (e) {
            console.log(`  ⚠️ ${win.projectName} (port ${win.port}) — connection failed: ${e.message}`);
        }
    }

    // Set active window: keep previous if still valid, otherwise use first
    if (!activeWindowId || !cdpWindows.has(activeWindowId) ||
        cdpWindows.get(activeWindowId).connection?.ws?.readyState !== WebSocket.OPEN) {
        // Prefer non-Manager windows (Manager has no chat DOM)
        const nonManager = [...cdpWindows.entries()].find(([, w]) =>
            !w.isManager && w.connection?.ws?.readyState === WebSocket.OPEN);
        const firstValid = nonManager || [...cdpWindows.entries()].find(([, w]) =>
            w.connection?.ws?.readyState === WebSocket.OPEN);
        if (firstValid) {
            activeWindowId = firstValid[0];
        }
    }

    if (activeWindowId && cdpWindows.has(activeWindowId)) {
        cdpConnection = cdpWindows.get(activeWindowId).connection;
        const proj = cdpWindows.get(activeWindowId).projectName;
        console.log(`  🎯 Active window: ${proj}\n`);
    }
}

// Background polling
async function startPolling(wss) {
    let lastErrorLog = 0;
    let isConnecting = false;
    let consecutiveSnapshotFailures = 0;

    const poll = async () => {
        // Detect stale CDP — force reconnect after consecutive failures
        if (consecutiveSnapshotFailures >= 5 && cdpConnection && activeWindowId) {
            console.log('🔄 CDP appears stale (5+ failures). Force-reconnecting active window...');
            consecutiveSnapshotFailures = 0;
            const win = cdpWindows.get(activeWindowId);
            if (win) {
                try {
                    if (win.connection?.ws) try { win.connection.ws.close(); } catch (_) {}
                    win.connection = await connectCDP(win.url);
                    cdpWindows.set(activeWindowId, win);
                    cdpConnection = win.connection;
                    console.log('✅ CDP force-reconnected for:', win.projectName);
                } catch (e) {
                    console.log('❌ Force-reconnect failed:', e.message);
                    cdpConnection = null;
                }
            }
        }

        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                // Was connected, now lost
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
            }
            try {
                await initCDP();
                if (cdpConnection) {
                    console.log('✅ CDP Connection established from polling loop');
                    isConnecting = false;
                    consecutiveSnapshotFailures = 0;
                }
            } catch (err) {
                // Not found yet, just wait for next cycle
            }
            setTimeout(poll, 2000); // Try again in 2 seconds if not found
            return;
        }

        try {
            const currentWindowId = activeWindowId;
            const snapshot = await captureSnapshot(cdpConnection);
            // Discard if window switched while capturing
            if (activeWindowId !== currentWindowId) {
                setTimeout(poll, 200); // Quick retry with current window
                return;
            }
            if (snapshot && !snapshot.error) {
                // Tag snapshot with window identity
                snapshot.windowId = activeWindowId;
                const activeWin = cdpWindows.get(activeWindowId);
                snapshot.projectName = activeWin?.projectName || 'Unknown';
                const hash = hashString(snapshot.html);

                // Only update if content changed
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;

                    // Broadcast to all connected clients
                    // Send snapshot data directly via WebSocket (eliminates HTTP round-trip)
                    const wsPayload = JSON.stringify({
                        type: 'snapshot_data',
                        html: snapshot.html,
                        stats: snapshot.stats,
                        windowId: activeWindowId,
                        projectName: activeWin?.projectName || 'Unknown',
                        timestamp: new Date().toISOString()
                    });
                    wss.clients.forEach(client => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(wsPayload);
                        }
                    });

                    console.log(`📸 Snapshot updated(hash: ${hash})`);
                }
                consecutiveSnapshotFailures = 0;
            } else {
                // Snapshot is null or has error
                consecutiveSnapshotFailures++;
                const now = Date.now();
                if (!lastErrorLog || now - lastErrorLog > 10000) {
                    const errorMsg = snapshot?.error || 'No valid snapshot captured (check contexts)';
                    console.warn(`⚠️  Snapshot capture issue: ${errorMsg} `);
                    if (errorMsg.includes('container not found')) {
                        console.log('   (Tip: Ensure an active chat is open in Antigravity)');
                    }
                    if (cdpConnection.contexts.length === 0) {
                        console.log('   (Tip: No active execution contexts found. Try interacting with the Antigravity window)');
                    }
                    lastErrorLog = now;
                }
            }
        } catch (err) {
            console.error('Poll error:', err.message);
        }

        setTimeout(poll, POLL_INTERVAL);
    };

    poll();
}

// Create Express app
async function createServer() {
    const app = express();

    // Check for SSL certificates
    const keyPath = join(__dirname, 'certs', 'server.key');
    const certPath = join(__dirname, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });

    // Initialize Auth Token (wait for hashString to be available)
    AUTH_TOKEN = hashString(APP_PASSWORD + 'antigravity_salt');

    app.use(compression());
    app.use(express.json({ limit: '50mb' }));
    app.use(cookieParser('antigravity_secret_key_1337'));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware
    app.use((req, res, next) => {
        const publicPaths = ['/login', '/login.html', '/favicon.ico'];
        if (publicPaths.includes(req.path) || req.path.startsWith('/css/')) {
            return next();
        }

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            return next();
        }

        // Magic Link / QR Code Auto-Login
        if (req.query.key === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            // Remove the key from the URL by redirecting to the base path
            return res.redirect('/');
        }

        const token = req.signedCookies[AUTH_COOKIE_NAME];
        if (token === AUTH_TOKEN) {
            return next();
        }

        // If it's an API request, return 401, otherwise redirect to login
        if (req.xhr || req.headers.accept?.includes('json') || req.path.startsWith('/snapshot') || req.path.startsWith('/send')) {
            res.status(401).json({ error: 'Unauthorized' });
        } else {
            res.redirect('/login.html');
        }
    });

    app.use(express.static(join(__dirname, 'public')));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Get current snapshot
    app.get('/snapshot', (req, res) => {
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        // Include window identity so client can detect stale data
        const response = {
            ...lastSnapshot,
            windowId: activeWindowId,
        };
        const activeWin = cdpWindows.get(activeWindowId);
        if (activeWin) response.projectName = activeWin.projectName;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(response);
    });

    // Health check endpoint
    app.get('/health', (req, res) => {
        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1, // WebSocket.OPEN = 1
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            https: hasSSL
        });
    });

    // List all Antigravity windows
    app.get('/windows', async (req, res) => {
        // Re-discover windows to catch newly opened ones
        try {
            const freshWindows = await discoverAllCDP();

            // Build a set of fresh IDs for cleanup
            const freshIds = new Set(freshWindows.map(w => w.id));
            const freshNames = new Set(freshWindows.map(w => w.projectName));

            // Remove stale windows: either no longer found by ID, or same projectName
            // but different ID (target ID changed between discoveries)
            for (const [id, win] of cdpWindows.entries()) {
                if (!freshIds.has(id)) {
                    // Window ID not found in fresh discovery — it's stale
                    try { win.connection?.ws?.close(); } catch (e) { /* ignore */ }
                    cdpWindows.delete(id);
                    console.log(`🧹 Removed stale window: ${win.projectName} (${id})`);
                }
            }

            // Also deduplicate: if a fresh window has the same projectName as an
            // existing entry with a different ID, remove the old one first
            for (const win of freshWindows) {
                if (!cdpWindows.has(win.id)) {
                    // Check if there's already a window with the same projectName
                    for (const [existingId, existingWin] of cdpWindows.entries()) {
                        if (existingWin.projectName === win.projectName && existingId !== win.id) {
                            try { existingWin.connection?.ws?.close(); } catch (e) { /* ignore */ }
                            cdpWindows.delete(existingId);
                            console.log(`🔄 Replaced duplicate window: ${win.projectName} (${existingId} → ${win.id})`);
                        }
                    }
                    try {
                        const conn = await connectCDP(win.url);
                        cdpWindows.set(win.id, { ...win, connection: conn });
                    } catch (e) { /* skip */ }
                }
            }
        } catch (e) { /* discovery failed, use cached */ }

        const windowList = [...cdpWindows.entries()].map(([id, win]) => ({
            id,
            port: win.port,
            projectName: win.projectName,
            title: win.title,
            isManager: win.isManager || false,
            active: id === activeWindowId,
            connected: win.connection?.ws?.readyState === WebSocket.OPEN
        }));

        // Final dedup: keep only the first Manager window
        let managerSeen = false;
        const dedupedList = windowList.filter(w => {
            if (w.isManager) {
                if (managerSeen) return false;
                managerSeen = true;
            }
            return true;
        });

        // Sort: Manager first, then alphabetical
        dedupedList.sort((a, b) => {
            if (a.isManager && !b.isManager) return -1;
            if (!a.isManager && b.isManager) return 1;
            return a.projectName.localeCompare(b.projectName);
        });
        res.json({ windows: dedupedList, activeWindowId });
    });

    // Switch active window
    app.post('/switch-window', async (req, res) => {
        const { windowId } = req.body;
        if (!windowId) return res.status(400).json({ error: 'windowId required' });

        const win = cdpWindows.get(windowId);
        if (!win) return res.status(404).json({ error: 'Window not found' });

        // Always force-reconnect CDP — stale connections look OPEN but have dead contexts
        try {
            if (win.connection?.ws) {
                try { win.connection.ws.close(); } catch (_) {}
            }
            win.connection = await connectCDP(win.url);
            cdpWindows.set(windowId, win);
        } catch (e) {
            return res.status(500).json({ error: 'Failed to connect: ' + e.message });
        }

        activeWindowId = windowId;
        cdpConnection = win.connection;
        lastSnapshot = null;  // Force fresh snapshot
        lastSnapshotHash = null;

        console.log(`🪟 Switched to window: ${win.projectName} (port ${win.port})`);

        // Capture immediate snapshot for the new window
        try {
            const snapshot = await captureSnapshot(cdpConnection);
            if (snapshot && !snapshot.error) {
                lastSnapshot = snapshot;
                lastSnapshotHash = hashString(snapshot.html);
            }
        } catch (e) { /* will be captured on next poll */ }

        res.json({
            success: true,
            activeWindowId,
            projectName: win.projectName
        });
    });

    // Close a window (Antigravity project)
    app.post('/close-window', async (req, res) => {
        const { windowId } = req.body;
        if (!windowId) return res.status(400).json({ error: 'windowId required' });

        const win = cdpWindows.get(windowId);
        if (!win) return res.status(404).json({ error: 'Window not found' });

        // Don't allow closing manager
        if (win.isManager) {
            return res.status(400).json({ error: 'Cannot close Manager window' });
        }

        const projectName = win.projectName;
        console.log(`🗑️ Attempting to close window: ${projectName} (${windowId})`);

        try {
            // Extract the target ID from our windowId format ("target-{targetId}")
            const targetId = windowId.replace('target-', '');
            let closed = false;

            // Strategy 1: Use Chrome DevTools HTTP API to close the target
            // /json/close/{targetId} returns plain text, NOT JSON, so we can't use getJson
            try {
                await new Promise((resolve, reject) => {
                    http.get(`http://127.0.0.1:${win.port}/json/close/${targetId}`, (response) => {
                        let body = '';
                        response.on('data', chunk => body += chunk);
                        response.on('end', () => {
                            console.log(`  /json/close response: ${body.trim()}`);
                            closed = body.includes('closing') || response.statusCode === 200;
                            resolve();
                        });
                    }).on('error', (e) => {
                        console.log(`  /json/close failed: ${e.message}`);
                        resolve(); // Don't reject, try next strategy
                    });
                });
            } catch (e) {
                console.log(`  /json/close error: ${e.message}`);
            }

            // Strategy 2: If /json/close didn't work, try CDP Page.close
            if (!closed && win.connection && win.connection.ws?.readyState === WebSocket.OPEN) {
                try {
                    await win.connection.call('Page.close', {});
                    closed = true;
                    console.log(`  Closed via Page.close`);
                } catch (e) {
                    console.log(`  Page.close failed: ${e.message}`);
                }
            }

            // Strategy 3: Try BrowserTarget.close via CDP
            if (!closed && win.connection && win.connection.ws?.readyState === WebSocket.OPEN) {
                try {
                    await win.connection.call('Target.closeTarget', { targetId });
                    closed = true;
                    console.log(`  Closed via Target.closeTarget`);
                } catch (e) {
                    console.log(`  Target.closeTarget failed: ${e.message}`);
                }
            }

            // Clean up from our map regardless
            cdpWindows.delete(windowId);

            // If we just closed the active window, switch to Manager or first available
            if (activeWindowId === windowId) {
                const remaining = [...cdpWindows.entries()];
                const manager = remaining.find(([, w]) => w.isManager);
                const next = manager || remaining[0];
                if (next) {
                    activeWindowId = next[0];
                    cdpConnection = next[1].connection;
                    lastSnapshot = null;
                    lastSnapshotHash = null;
                    console.log(`  🪟 Auto-switched to: ${next[1].projectName}`);
                }
            }

            console.log(`🗑️ ${closed ? 'Closed' : 'Attempted to close'} window: ${projectName}`);
            res.json({ success: true, closed, projectName, activeWindowId });
        } catch (e) {
            console.error(`❌ Close window error:`, e.message);
            res.status(500).json({ error: e.message });
        }
    });

    // Open a folder as a new workspace in Antigravity
    app.post('/open-workspace', async (req, res) => {
        const { folderPath } = req.body;
        if (!folderPath) return res.status(400).json({ error: 'folderPath required' });

        try {
            const agBin = process.env.AG_BIN_PATH || (process.platform === 'win32'
                ? join(os.homedir(), 'AppData', 'Local', 'Programs', 'Antigravity', 'bin', 'antigravity.cmd')
                : process.platform === 'darwin'
                    ? '/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity'
                    : 'antigravity');
            const debugPort = PORTS[0] || 9000;
            console.log(`📂 Opening workspace: "${agBin}" "${folderPath}" --remote-debugging-port=${debugPort}`);
            const child = spawn(agBin, [folderPath, `--remote-debugging-port=${debugPort}`], {
                detached: true,
                stdio: 'ignore',
                shell: true
            });
            child.on('error', (err) => console.log(`⚠️ Spawn error: ${err.message}`));
            child.unref();
            res.json({ success: true, message: `Opening ${folderPath}...` });
        } catch (e) {
            console.log(`⚠️ Open workspace error: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // List project folders for workspace autocomplete
    app.get('/list-projects', (req, res) => {
        const projectsDir = process.env.PROJECTS_DIR || (process.platform === 'win32' ? 'C:\\Proyects' : join(os.homedir(), 'Projects'));
        try {
            const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
            const folders = entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .map(e => ({
                    name: e.name,
                    path: join(projectsDir, e.name)
                }));
            res.json({ projects: folders, basePath: projectsDir });
        } catch (e) {
            res.json({ projects: [], basePath: projectsDir, error: e.message });
        }
    });

    // List available workflows
    app.get('/list-workflows', (req, res) => {
        try {
            const projectsDir = process.env.PROJECTS_DIR || (process.platform === 'win32' ? 'C:\\Proyects' : join(os.homedir(), 'Projects'));

            // Determine current project path from active window
            let activeProjectDir = null;
            if (activeWindowId && cdpWindows.has(activeWindowId)) {
                const win = cdpWindows.get(activeWindowId);
                if (win.projectName && win.projectName !== '⚡ Manager') {
                    activeProjectDir = join(projectsDir, win.projectName);
                }
            }

            // Search multiple possible workflow locations
            const workflowDirs = [
                // Global workflows (shared across all projects)
                join(projectsDir, 'gemini', 'workflows'),
                join(projectsDir, '.gemini', 'workflows'),
                // Phone-connect's own workflows
                join(__dirname, '.agent', 'workflows'),
                join(__dirname, '.agents', 'workflows'),
                join(__dirname, '_agent', 'workflows'),
            ];

            // Add active project's workflow dirs
            if (activeProjectDir) {
                workflowDirs.push(
                    join(activeProjectDir, '.agent', 'workflows'),
                    join(activeProjectDir, '.agents', 'workflows'),
                    join(activeProjectDir, '_agent', 'workflows'),
                    join(activeProjectDir, '_agents', 'workflows'),
                );
            }

            const workflows = [];
            const seen = new Set(); // Deduplicate by name

            for (const dir of workflowDirs) {
                if (!fs.existsSync(dir)) continue;
                const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
                for (const file of files) {
                    const name = '/' + file.replace('.md', '');
                    if (seen.has(name)) continue;
                    seen.add(name);
                    // Read first line for description
                    try {
                        const content = fs.readFileSync(join(dir, file), 'utf8');
                        const descMatch = content.match(/description:\s*(.+)/i);
                        const desc = descMatch ? descMatch[1].trim() : name;
                        workflows.push({ name, description: desc, file });
                    } catch (e) {
                        workflows.push({ name, description: name, file });
                    }
                }
            }
            res.json({ workflows });
        } catch (e) {
            res.json({ workflows: [], error: e.message });
        }
    });

    // SSL status endpoint
    app.get('/ssl-status', (req, res) => {
        const keyPath = join(__dirname, 'certs', 'server.key');
        const certPath = join(__dirname, 'certs', 'server.cert');
        const certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
        res.json({
            enabled: hasSSL,
            certsExist: certsExist,
            message: hasSSL ? 'HTTPS is active' :
                certsExist ? 'Certificates exist, restart server to enable HTTPS' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', { cwd: __dirname, stdio: 'pipe' });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    });

    // Debug UI Endpoint
    app.get('/debug-ui', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    // Set Mode
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    // Set Model
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    // Stop Generation
    app.post('/stop', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        const result = await injectMessage(cdpConnection, message);

        // Always return 200 - the message usually goes through even if CDP reports issues
        // The client will refresh and see if the message appeared
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
    });

    // Upload image (paste into editor via CDP - multi-strategy)
    app.post('/upload-image', async (req, res) => {
        const { image, filename } = req.body;
        if (!image) return res.status(400).json({ error: 'Image data required' });
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });

        try {
            // Extract base64 data and mime type
            const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
            const mimeMatch = image.match(/^data:(image\/\w+);base64,/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

            const safeFilename = JSON.stringify(filename || 'upload.png');
            const safeMimeType = JSON.stringify(mimeType);

            // Pass base64 directly into the expression — no DOM.setFileInputFiles needed
            // This ensures the File object and editor are in THE SAME execution context
            const insertExpr = `(async () => {
    try {
        // Reconstruct the File from base64
        const b64 = ${JSON.stringify(base64Data)
                };
    const byteChars = atob(b64);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: ${safeMimeType} });
const file = new File([blob], ${safeFilename}, { type: ${safeMimeType} });

// Find the editor (same selectors as injectMessage)
const editors = [...document.querySelectorAll(
    '#conversation [contenteditable="true"], ' +
    '#chat [contenteditable="true"], ' +
    '#cascade [contenteditable="true"], ' +
    '[data-lexical-editor="true"]'
)].filter(el => el.offsetParent !== null);
const editor = editors.at(-1);
if (!editor) {
    return { ok: false, error: 'editor_not_found', totalEditors: document.querySelectorAll('[contenteditable="true"]').length };
}

editor.focus();

// --- Strategy 1: Paste Event ---
try {
    const dt = new DataTransfer();
    dt.items.add(file);
    const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
    });
    const handled = !editor.dispatchEvent(pasteEvent);
    if (handled || pasteEvent.defaultPrevented) {
        return { ok: true, method: 'paste_event', fileName: file.name };
    }
} catch (e1) { }

await new Promise(r => setTimeout(r, 100));

// --- Strategy 2: Drop Event ---
try {
    const dropDt = new DataTransfer();
    dropDt.items.add(file);
    editor.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dropDt }));
    editor.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dropDt }));
    const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dropDt });
    const dropHandled = !editor.dispatchEvent(dropEvent);
    if (dropHandled || dropEvent.defaultPrevented) {
        return { ok: true, method: 'drop_event', fileName: file.name };
    }
} catch (e2) { }

await new Promise(r => setTimeout(r, 100));

// --- Strategy 3: Click the attach/context button and use its native file input ---
try {
    const attachBtns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(btn => {
        if (btn.offsetParent === null) return false;
        const svg = btn.querySelector('svg.lucide-plus, svg.lucide-paperclip, svg.lucide-image, svg[class*="plus"], svg[class*="paperclip"]');
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const tooltip = (btn.getAttribute('data-tooltip-id') || '').toLowerCase();
        return svg || label.includes('attach') || label.includes('image') || label.includes('file') ||
            tooltip.includes('context') || tooltip.includes('attach') || tooltip.includes('media');
    });
    const bottomBtns = attachBtns.filter(btn => btn.getBoundingClientRect().top > window.innerHeight * 0.5);
    if (bottomBtns.length > 0) {
        bottomBtns[0].click();
        await new Promise(r => setTimeout(r, 500));
        const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
        if (fileInputs.length > 0) {
            const nativeInput = fileInputs[fileInputs.length - 1];
            const nativeDt = new DataTransfer();
            nativeDt.items.add(file);
            nativeInput.files = nativeDt.files;
            nativeInput.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true, method: 'native_file_input', fileName: file.name };
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
} catch (e3) { }

return { ok: false, error: 'all_strategies_failed', editorTag: editor.tagName, editorClasses: editor.className?.substring(0, 100) };
                } catch (e) {
    return { ok: false, error: e.toString() };
}
            }) ()`;

            let lastResult = null;

            for (const ctx of cdpConnection.contexts) {
                try {
                    const result = await cdpConnection.call('Runtime.evaluate', {
                        expression: insertExpr,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: ctx.id
                    });

                    const val = result.result?.value;
                    console.log(`📎 Image upload ctx ${ctx.id}: ${JSON.stringify(val)} `);
                    lastResult = val;

                    if (val && val.ok) {
                        return res.json({ success: true, details: val });
                    }
                } catch (e) {
                    console.error('Upload context error:', e.message);
                }
            }

            return res.json({
                success: false,
                error: lastResult?.error || 'upload_failed',
                details: lastResult
            });
        } catch (e) {
            console.error('Upload error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Send Enter key (for image-only sends)
    app.post('/send-enter', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP not connected' });

        const EXPRESSION = `(async () => {
    const editors = [...document.querySelectorAll('#conversation [contenteditable="true"], #chat [contenteditable="true"], #cascade [contenteditable="true"]')]
        .filter(el => el.offsetParent !== null);
    const editor = editors.at(-1);
    if (!editor) return { ok: false, error: 'editor_not_found' };

    // Try submit button first
    const submit = document.querySelector('svg.lucide-arrow-right')?.closest('button');
    if (submit && !submit.disabled) {
        submit.click();
        return { ok: true, method: 'click_submit' };
    }

    // Fallback: Enter key
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' }));
    return { ok: true, method: 'enter_key' };
})()`;

        for (const ctx of cdpConnection.contexts) {
            try {
                const result = await cdpConnection.call('Runtime.evaluate', {
                    expression: EXPRESSION,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                if (result.result && result.result.value && result.result.value.ok) {
                    return res.json({ success: true, details: result.result.value });
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'Could not send' });
    });

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (err) {
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    });

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', async (req, res) => {
        const results = {};
        for (const port of PORTS) {
            try {
                const list = await getJson(`http://127.0.0.1:${port}/json/list`);
                results[port] = list;
            } catch (e) {
                results[port] = e.message;
            }
        }
        res.json(results);
    });

    // Terminal endpoint - run commands on the host
    app.post('/api/terminal', async (req, res) => {
        const { command } = req.body;
        if (!command) return res.status(400).json({ error: 'command required' });

        const TIMEOUT_MS = 30000; // 30 second timeout

        try {
            const isWin = process.platform === 'win32';
            const shell = isWin ? 'powershell' : '/bin/sh';
            const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];
            const proc = spawn(shell, shellArgs, {
                cwd: process.cwd(),
                env: process.env,
                windowsHide: true
            });

            let stdout = '';
            let stderr = '';
            let killed = false;

            const timer = setTimeout(() => {
                killed = true;
                proc.kill('SIGTERM');
            }, TIMEOUT_MS);

            proc.stdout.on('data', (d) => { stdout += d.toString(); });
            proc.stderr.on('data', (d) => { stderr += d.toString(); });

            await new Promise((resolve) => {
                proc.on('close', (code, signal) => {
                    clearTimeout(timer);
                    res.json({
                        stdout: stdout.trimEnd(),
                        stderr: killed ? stderr.trimEnd() + '\n[Command timed out after 30s]' : stderr.trimEnd(),
                        exitCode: code ?? -1,
                        signal: signal || undefined
                    });
                    resolve();
                });
                proc.on('error', (err) => {
                    clearTimeout(timer);
                    res.json({ stdout: '', stderr: err.message, exitCode: -1 });
                    resolve();
                });
            });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // WebSocket connection with Auth check
    wss.on('connection', (ws, req) => {
        // Parse cookies from headers
        const rawCookies = req.headers.cookie || '';
        const parsedCookies = {};
        rawCookies.split(';').forEach(c => {
            const [k, v] = c.trim().split('=');
            if (k && v) {
                try {
                    parsedCookies[k] = decodeURIComponent(v);
                } catch (e) {
                    parsedCookies[k] = v;
                }
            }
        });

        // Verify signed cookie manually
        const signedToken = parsedCookies[AUTH_COOKIE_NAME];
        let isAuthenticated = false;

        // Exempt local Wi-Fi devices from authentication
        if (isLocalRequest(req)) {
            isAuthenticated = true;
        } else if (signedToken) {
            const token = cookieParser.signedCookie(signedToken, 'antigravity_secret_key_1337');
            if (token === AUTH_TOKEN) {
                isAuthenticated = true;
            }
        }

        if (!isAuthenticated) {
            console.log('🚫 Unauthorized WebSocket connection attempt');
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
            setTimeout(() => ws.close(), 100);
            return;
        }

        console.log('📱 Client connected (Authenticated)');

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    // Remote Click
    app.post('/remote-click', async (req, res) => {
        const { selector, index, textContent } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await clickElement(cdpConnection, { selector, index, textContent });
        res.json(result);
    });

    // Remote Scroll - sync phone scroll to desktop
    app.post('/remote-scroll', async (req, res) => {
        const { scrollTop, scrollPercent } = req.body;
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
        res.json(result);
    });

    // Get App State
    app.get('/app-state', async (req, res) => {
        if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
        const result = await getAppState(cdpConnection);
        res.json(result);
    });

    // Start New Chat
    app.post('/new-chat', async (req, res) => {
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await startNewChat(cdpConnection);
        res.json(result);
    });

    // Server-side model name filter (catches anything the CDP-side filter misses)
    const SERVER_MODEL_RE = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\b/i;

    // Get Chat History
    app.get('/chat-history', async (req, res) => {
        if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
        const result = await getChatHistory(cdpConnection);
        // Post-filter: remove model names that slipped through CDP-side filter
        if (result.chats && result.chats.length > 0) {
            const before = result.chats.length;
            result.chats = result.chats.filter(c => !SERVER_MODEL_RE.test(c.title));
            if (result.chats.length !== before) {
                console.log(`🔽 Server post-filter removed ${before - result.chats.length} model-name entries`);
            }
        }
        res.json(result);
    });

    // Select a Chat
    app.post('/select-chat', async (req, res) => {
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Chat title required' });
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await selectChat(cdpConnection, title);
        res.json(result);
    });

    // Close a conversation tab in Antigravity via CDP
    app.post('/close-tab', async (req, res) => {
        const { title } = req.body;
        if (!title) return res.status(400).json({ error: 'Tab title required' });
        if (!cdpConnection) return res.status(503).json({ error: 'CDP disconnected' });

        const safeTitle = JSON.stringify(title);

        // Strategy 1: Try DOM-based approaches (find close button, middle-click, context menu)
        const EXP = `(async () => {
    try {
        const targetTitle = ${safeTitle};

        // Find tab element by title text
        const allElements = Array.from(document.querySelectorAll('div, span, a, button'));
        let tabElement = null;
        let maxDepth = -1;
        
        for (const el of allElements) {
            if (el.offsetParent === null) continue;
            if (el.children.length > 10) continue;
            const text = (el.innerText || el.textContent || '').trim();
            if (!text) continue;
            
            const matchLen = Math.min(25, targetTitle.length, text.length);
            if (text.substring(0, matchLen) === targetTitle.substring(0, matchLen) ||
                targetTitle.startsWith(text.substring(0, matchLen))) {
                
                const parent = el.closest('[class*="tab"], [role="tab"], [data-tab]') || el.parentElement;
                if (!parent) continue;
                
                let depth = 0;
                let p = el;
                while (p) { depth++; p = p.parentElement; }
                
                if (depth > maxDepth) {
                    maxDepth = depth;
                    tabElement = el;
                }
            }
        }
        
        if (tabElement) {
            // Walk up to find the tab container
            let tabContainer = tabElement;
            for (let i = 0; i < 5; i++) {
                if (!tabContainer.parentElement) break;
                const cls = (tabContainer.className || '').toString().toLowerCase();
                if (cls.includes('tab') || tabContainer.getAttribute('role') === 'tab') break;
                tabContainer = tabContainer.parentElement;
            }
            
            // Look for a close/X button within the tab container
            const closeBtn = tabContainer.querySelector(
                'svg.lucide-x, svg.lucide-close, svg[class*="close"], svg[class*="x"],' +
                'button[class*="close"], button[aria-label*="close"], button[aria-label*="Close"],' +
                '[class*="close-btn"], [class*="closeBtn"]'
            );
            
            if (closeBtn) {
                const btn = closeBtn.closest('button') || closeBtn;
                btn.click();
                return { success: true, method: 'close_button', title: targetTitle };
            }
            
            // Middle-click the tab
            try {
                const rect = tabContainer.getBoundingClientRect();
                tabContainer.dispatchEvent(new MouseEvent('auxclick', {
                    bubbles: true, button: 1, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2
                }));
                return { success: true, method: 'middle_click', title: targetTitle };
            } catch(e) {}
            
            // Right-click context menu
            try {
                const rect = tabContainer.getBoundingClientRect();
                tabContainer.dispatchEvent(new MouseEvent('contextmenu', {
                    bubbles: true, button: 2, clientX: rect.left + rect.width/2, clientY: rect.top + rect.height/2
                }));
                await new Promise(r => setTimeout(r, 500));
                
                const menuItems = Array.from(document.querySelectorAll('[class*="menu"] [class*="item"], [role="menuitem"]'));
                const closeItem = menuItems.find(item => {
                    const t = (item.textContent || '').toLowerCase();
                    return t.includes('close') && !t.includes('close all') && !t.includes('close other');
                });
                if (closeItem) {
                    closeItem.click();
                    return { success: true, method: 'context_menu_close', title: targetTitle };
                }
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            } catch(e) {}
        }
        
        // Return tab coordinates if found, for keyboard shortcut fallback
        if (tabElement) {
            const rect = tabElement.getBoundingClientRect();
            return { success: false, needsKeyboard: true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2), title: targetTitle };
        }
        return { success: false, error: 'tab_not_found', title: targetTitle };
    } catch(e) {
        return { error: e.toString() };
    }
})()`;

        // Try DOM strategies first
        for (const ctx of cdpConnection.contexts) {
            try {
                const result = await cdpConnection.call('Runtime.evaluate', {
                    expression: EXP,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                });
                const val = result.result?.value;
                if (val && val.success) {
                    console.log(`🗑️ Closed tab "${title}" via ${val.method}`);
                    return res.json(val);
                }

                // Strategy 2: CDP keyboard shortcut (Cmd+W on macOS, Ctrl+W otherwise)
                // First click the tab to select it, then send the shortcut
                if (val && val.needsKeyboard && val.x && val.y) {
                    try {
                        // Click the tab to make sure it's focused
                        await cdpConnection.call('Input.dispatchMouseEvent', {
                            type: 'mousePressed', x: val.x, y: val.y, button: 'left', clickCount: 1
                        });
                        await cdpConnection.call('Input.dispatchMouseEvent', {
                            type: 'mouseReleased', x: val.x, y: val.y, button: 'left', clickCount: 1
                        });
                        await new Promise(r => setTimeout(r, 300));

                        // Send Cmd+W (macOS) / Ctrl+W (other) via CDP native key events
                        const isMac = process.platform === 'darwin';
                        const modifiers = isMac ? 4 : 2; // 4=Meta(Cmd), 2=Control
                        await cdpConnection.call('Input.dispatchKeyEvent', {
                            type: 'keyDown',
                            key: 'w',
                            code: 'KeyW',
                            windowsVirtualKeyCode: 87,
                            nativeVirtualKeyCode: 87,
                            modifiers
                        });
                        await cdpConnection.call('Input.dispatchKeyEvent', {
                            type: 'keyUp',
                            key: 'w',
                            code: 'KeyW',
                            windowsVirtualKeyCode: 87,
                            nativeVirtualKeyCode: 87,
                            modifiers
                        });

                        console.log(`🗑️ Closed tab "${title}" via keyboard shortcut (${isMac ? 'Cmd' : 'Ctrl'}+W)`);
                        return res.json({ success: true, method: 'keyboard_shortcut', title });
                    } catch (keyErr) {
                        console.warn(`⚠️ Keyboard shortcut close failed:`, keyErr.message);
                    }
                }
            } catch (e) { }
        }
        res.json({ success: false, error: 'Could not close tab' });
    });

    // Get current active conversation title
    app.get('/current-conversation', async (req, res) => {
        if (!cdpConnection) return res.json({ title: null, error: 'CDP disconnected' });

        const EXP = `(() => {
            try {
                if (typeof document === 'undefined') return { title: null };
                
                // Strategy 1: Look for breadcrumb/header with conversation title
                // Antigravity typically shows the conversation title in a header area
                const headerCandidates = document.querySelectorAll('h1, h2, [class*="title"], [class*="header"] span, [class*="breadcrumb"] span');
                for (const el of headerCandidates) {
                    const text = (el.textContent || '').trim();
                    if (text.length > 3 && text.length < 100 && !text.includes('\\n')) {
                        // Skip UI labels
                        const lower = text.toLowerCase();
                        if (['planning', 'coding', 'general', 'creative writing', 'data analysis'].includes(lower)) continue;
                        if (/^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\\b/i.test(text)) continue;
                        return { title: text, source: 'header' };
                    }
                }
                
                // Strategy 2: Check document.title or page title
                const pageTitle = document.title || '';
                if (pageTitle && pageTitle.length > 3 && !pageTitle.includes('Antigravity')) {
                    return { title: pageTitle, source: 'document.title' };
                }
                
                // Strategy 3: Look for the first user message as a fallback title
                const userMsgs = document.querySelectorAll('[class*="user"] p, [data-role="user"] p, .whitespace-pre-wrap');
                for (const msg of userMsgs) {
                    const text = (msg.textContent || '').trim();
                    if (text.length > 5 && text.length < 80) {
                        // Use first ~50 chars of first user message as title
                        const title = text.length > 50 ? text.substring(0, 47) + '...' : text;
                        return { title, source: 'first_message' };
                    }
                }
                
                return { title: null, source: 'not_found' };
            } catch(e) {
                return { title: null, error: e.toString() };
            }
        })()`;

        for (const ctx of cdpConnection.contexts) {
            try {
                const result = await cdpConnection.call('Runtime.evaluate', {
                    expression: EXP,
                    returnByValue: true,
                    contextId: ctx.id
                });
                if (result.result?.value?.title) {
                    return res.json(result.result.value);
                }
            } catch (e) { }
        }
        res.json({ title: null, source: 'no_context' });
    });

    // Check if Chat is Open
    app.get('/chat-status', async (req, res) => {
        if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
        const result = await hasChatOpen(cdpConnection);
        res.json(result);
    });

    // --- Markdown File Viewer API ---
    const ARTIFACTS_BASE = join(os.homedir(), '.gemini', 'antigravity', 'brain');

    // Find an artifact .md file by title search across all conversations
    app.get('/api/find-artifact', (req, res) => {
        const title = (req.query.title || '').trim();
        if (!title) return res.status(400).json({ error: 'title required' });

        try {
            // Convert title to possible filenames
            const snakeCase = title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
            const possibleNames = [
                snakeCase + '.md',
                snakeCase.replace(/_/g, '-') + '.md',
            ];

            // Search all conversation directories in brain/
            if (!fs.existsSync(ARTIFACTS_BASE)) {
                return res.status(404).json({ error: 'Brain directory not found' });
            }

            const convDirs = fs.readdirSync(ARTIFACTS_BASE, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith('.'));

            // Search most recent first (sorted reverse by mtime)
            const dirsWithTime = convDirs.map(d => {
                const dirPath = join(ARTIFACTS_BASE, d.name);
                try {
                    return { name: d.name, path: dirPath, mtime: fs.statSync(dirPath).mtimeMs };
                } catch { return { name: d.name, path: dirPath, mtime: 0 }; }
            }).sort((a, b) => b.mtime - a.mtime);

            for (const dir of dirsWithTime) {
                try {
                    const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.md'));
                    for (const file of files) {
                        const lower = file.toLowerCase();
                        // Check filename match
                        if (possibleNames.some(n => lower === n)) {
                            const fullPath = join(dir.path, file);
                            const content = fs.readFileSync(fullPath, 'utf-8');
                            return res.json({
                                found: true,
                                path: dir.name + '/' + file,
                                absPath: fullPath,
                                content,
                                name: file
                            });
                        }
                    }
                } catch (e) { /* skip */ }
            }

            // Fallback: search file contents for the title
            for (const dir of dirsWithTime) {
                try {
                    const files = fs.readdirSync(dir.path).filter(f => f.endsWith('.md'));
                    for (const file of files) {
                        const fullPath = join(dir.path, file);
                        const content = fs.readFileSync(fullPath, 'utf-8');
                        // Check if file starts with a heading matching the title
                        const firstLine = content.split('\n')[0] || '';
                        if (firstLine.toLowerCase().includes(title.toLowerCase())) {
                            return res.json({
                                found: true,
                                path: dir.name + '/' + file,
                                absPath: fullPath,
                                content,
                                name: file
                            });
                        }
                    }
                } catch (e) { /* skip */ }
            }

            // Not found — list all available .md files in most recent conversation
            const available = [];
            if (dirsWithTime.length > 0) {
                const recentDir = dirsWithTime[0];
                try {
                    const files = fs.readdirSync(recentDir.path).filter(f => f.endsWith('.md'));
                    files.forEach(f => available.push(recentDir.name + '/' + f));
                } catch (e) {}
            }
            return res.status(404).json({ error: 'Artifact not found', searched: title, available });
        } catch (e) {
            console.error('Find artifact error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // --- Projects Directory API ---
    const PROJECTS_BASE = join(os.homedir(), '.gemini', 'antigravity', 'proyects');

    app.get('/api/projects', (req, res) => {
        try {
            if (!fs.existsSync(PROJECTS_BASE)) {
                return res.json({ projects: [], basePath: PROJECTS_BASE });
            }
            const entries = fs.readdirSync(PROJECTS_BASE, { withFileTypes: true });
            const projects = entries
                .filter(e => e.isDirectory() && !e.name.startsWith('.'))
                .map(e => {
                    const dirPath = join(PROJECTS_BASE, e.name);
                    let mtime = 0;
                    try { mtime = fs.statSync(dirPath).mtimeMs; } catch {}
                    return { name: e.name, mtime };
                })
                .sort((a, b) => b.mtime - a.mtime);
            res.json({ projects, basePath: PROJECTS_BASE });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Create a new project folder
    app.post('/api/create-project-folder', (req, res) => {
        const { name } = req.body;
        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Folder name is required' });
        }
        // Validate: only alphanumeric, hyphens, underscores, dots
        const safeName = name.trim();
        if (!safeName || /[\/\\:*?"<>|]/.test(safeName) || safeName.includes('..')) {
            return res.status(400).json({ error: 'Invalid folder name' });
        }
        const folderPath = join(PROJECTS_BASE, safeName);
        if (fs.existsSync(folderPath)) {
            return res.status(409).json({ error: 'Folder already exists' });
        }
        try {
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`📁 Created project folder: ${folderPath}`);
            res.json({ success: true, name: safeName, path: folderPath });
        } catch (e) {
            console.error(`⚠️ Create folder error: ${e.message}`);
            res.status(500).json({ error: e.message });
        }
    });

    // Browse files inside a project directory
    app.get('/api/project-files', (req, res) => {
        const project = req.query.project || '';
        const subdir = req.query.dir || '';
        const targetDir = join(PROJECTS_BASE, project, subdir);

        // Security: prevent directory traversal
        if (!targetDir.startsWith(PROJECTS_BASE)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (!fs.existsSync(targetDir)) {
                return res.json({ files: [], dirs: [], currentDir: subdir, project });
            }

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            const dirs = [];
            const files = [];

            // Browsable extensions for project files
            const BROWSABLE_EXTS = ['.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.css', '.html', '.env', '.yml', '.yaml', '.toml', '.prisma', '.sql', '.sh', '.dart', '.swift', '.py', '.go', '.rs'];
            const SKIP_DIRS = ['node_modules', '.git', '.next', 'build', 'dist', '.dart_tool', '.idea', '__pycache__'];

            for (const entry of entries) {
                if (entry.name.startsWith('.') && entry.name !== '.env') continue;
                const entryPath = join(targetDir, entry.name);

                if (entry.isDirectory()) {
                    if (SKIP_DIRS.includes(entry.name)) continue;
                    let fileCount = 0;
                    let dirMtime = 0;
                    try {
                        const subEntries = fs.readdirSync(entryPath);
                        fileCount = subEntries.length;
                        dirMtime = fs.statSync(entryPath).mtimeMs;
                    } catch {}
                    dirs.push({ name: entry.name, fileCount, mtime: dirMtime });
                } else {
                    const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
                    if (BROWSABLE_EXTS.includes(ext) || entry.name === 'Dockerfile' || entry.name === 'Makefile') {
                        const stat = fs.statSync(entryPath);
                        files.push({
                            name: entry.name,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            type: ext === '.md' ? 'markdown' : 'code',
                            absolutePath: entryPath
                        });
                    }
                }
            }

            dirs.sort((a, b) => b.mtime - a.mtime);
            files.sort((a, b) => new Date(b.modified) - new Date(a.modified));
            res.json({ files, dirs, currentDir: subdir, project });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read a project file's content
    app.get('/api/project-file-content', (req, res) => {
        const filePath = req.query.path || '';
        const fullPath = join(PROJECTS_BASE, filePath);

        if (!fullPath.startsWith(PROJECTS_BASE)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: 'File not found' });
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            const ext = fullPath.substring(fullPath.lastIndexOf('.')).toLowerCase();
            res.json({ content, type: ext === '.md' ? 'markdown' : 'code', path: filePath });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // List .md files in subdirectories
    app.get('/api/files', (req, res) => {
        const subdir = req.query.dir || '';
        const targetDir = join(ARTIFACTS_BASE, subdir);

        // Security: prevent directory traversal
        if (!targetDir.startsWith(ARTIFACTS_BASE)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (!fs.existsSync(targetDir)) {
                return res.json({ files: [], dirs: [], currentDir: subdir, basePath: ARTIFACTS_BASE });
            }

            const entries = fs.readdirSync(targetDir, { withFileTypes: true });
            const dirs = [];
            const files = [];

            // Browsable file extensions
            const BROWSABLE_EXTS = ['.md', '.png', '.webp', '.jpg', '.jpeg', '.svg', '.gif'];
            const IMAGE_EXTS = ['.png', '.webp', '.jpg', '.jpeg', '.svg', '.gif'];

            for (const entry of entries) {
                if (entry.name.startsWith('.')) continue; // skip hidden

                const entryPath = join(targetDir, entry.name);
                if (entry.isDirectory()) {
                    // Count browsable files in this subdirectory (1 level deep)
                    let fileCount = 0;
                    let dirMtime = 0;
                    try {
                        const subEntries = fs.readdirSync(entryPath);
                        fileCount = subEntries.filter(f => BROWSABLE_EXTS.some(ext => f.endsWith(ext))).length;
                        dirMtime = fs.statSync(entryPath).mtimeMs;
                    } catch { }
                    dirs.push({ name: entry.name, fileCount, mtime: dirMtime });
                } else {
                    const ext = entry.name.substring(entry.name.lastIndexOf('.')).toLowerCase();
                    if (BROWSABLE_EXTS.includes(ext)) {
                        const stat = fs.statSync(entryPath);
                        const isImage = IMAGE_EXTS.includes(ext);
                        files.push({
                            name: entry.name,
                            size: stat.size,
                            modified: stat.mtime.toISOString(),
                            type: isImage ? 'image' : 'markdown',
                            absolutePath: entryPath
                        });
                    }
                }
            }

            // Sort: dirs by newest first, files by newest first
            dirs.sort((a, b) => b.mtime - a.mtime);
            files.sort((a, b) => new Date(b.modified) - new Date(a.modified));

            res.json({ files, dirs, currentDir: subdir, basePath: ARTIFACTS_BASE });
        } catch (e) {
            console.error('File listing error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Read a specific file's content
    app.get('/api/file-content', (req, res) => {
        const filePath = req.query.path || '';
        const fullPath = join(ARTIFACTS_BASE, filePath);

        // Security: prevent directory traversal
        if (!fullPath.startsWith(ARTIFACTS_BASE)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        try {
            if (!fs.existsSync(fullPath)) {
                return res.status(404).json({ error: 'File not found' });
            }

            const content = fs.readFileSync(fullPath, 'utf-8');
            const stat = fs.statSync(fullPath);
            res.json({
                content,
                name: filePath.split(/[\\/]/).pop(),
                path: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString()
            });
        } catch (e) {
            console.error('File read error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Proxy local images for chat snapshot viewing
    // Security: Only allow image files within user's home directory
    app.get('/api/serve-image', (req, res) => {
        const filePath = req.query.path || '';
        const homeDir = os.homedir();

        if (!filePath.startsWith('/')) {
            return res.status(400).json({ error: 'Absolute path required' });
        }

        // Normalize to prevent traversal
        const resolved = join(filePath);
        if (!resolved.startsWith(homeDir)) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Only allow image extensions
        const ext = resolved.split('.').pop().toLowerCase();
        const mimeTypes = {
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'svg': 'image/svg+xml',
            'ico': 'image/x-icon',
            'bmp': 'image/bmp'
        };
        const mime = mimeTypes[ext];
        if (!mime) {
            return res.status(403).json({ error: 'Not an image file' });
        }

        try {
            if (!fs.existsSync(resolved)) {
                return res.status(404).json({ error: 'Image not found' });
            }
            res.setHeader('Content-Type', mime);
            res.setHeader('Cache-Control', 'public, max-age=3600');
            fs.createReadStream(resolved).pipe(res);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Read a file by absolute path (for artifact links in chat)
    // Security: Only allow .md files within user's home directory
    app.get('/api/read-file', (req, res) => {
        const filePath = req.query.path || '';
        const homeDir = os.homedir();

        // Security checks
        if (!filePath.startsWith('/')) {
            return res.status(400).json({ error: 'Absolute path required' });
        }
        if (!filePath.endsWith('.md')) {
            return res.status(403).json({ error: 'Only .md files allowed' });
        }
        // Normalize to prevent traversal
        const resolved = join(filePath);
        if (!resolved.startsWith(homeDir)) {
            return res.status(403).json({ error: 'Access denied - path outside home directory' });
        }

        try {
            if (!fs.existsSync(resolved)) {
                return res.status(404).json({ error: 'File not found: ' + filePath.split('/').pop() });
            }

            const content = fs.readFileSync(resolved, 'utf-8');
            const stat = fs.statSync(resolved);
            res.json({
                content,
                name: resolved.split('/').pop(),
                path: filePath,
                size: stat.size,
                modified: stat.mtime.toISOString()
            });
        } catch (e) {
            console.error('Read file error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    return { server, wss, app, hasSSL };
}

// Main
async function main() {
    try {
        await initCDP();
    } catch (err) {
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=9000 to connect.');
    }

    try {
        const { server, wss, app, hasSSL } = await createServer();

        // Start background polling (it will now handle reconnections)
        startPolling(wss);

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        server.listen(SERVER_PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
            if (hasSSL) {
                console.log(`💡 First time on phone? Accept the security warning to proceed.`);
            }
        });

        // Also start HTTP-only server on port 3002 for Tailscale access
        // (Tailscale traffic is already encrypted, so HTTPS is redundant)
        if (hasSSL) {
            const httpFallback = http.createServer(app);
            const httpPort = parseInt(SERVER_PORT, 10) + 1; // 3002

            // WebSocket on fallback too — so Tailscale clients get live updates
            const wssFallback = new WebSocketServer({ server: httpFallback });
            wssFallback.on('connection', (wsClient, req) => {
                // Reuse the same auth logic
                const rawCookies = req.headers.cookie || '';
                const parsedCookies = {};
                rawCookies.split(';').forEach(c => {
                    const [k, v] = c.trim().split('=');
                    if (k && v) {
                        try { parsedCookies[k] = decodeURIComponent(v); } catch (e) { parsedCookies[k] = v; }
                    }
                });

                let isAuthenticated = false;
                if (isLocalRequest(req)) {
                    isAuthenticated = true;
                } else {
                    const signedToken = parsedCookies[AUTH_COOKIE_NAME];
                    if (signedToken) {
                        const token = cookieParser.signedCookie(signedToken, 'antigravity_secret_key_1337');
                        if (token === AUTH_TOKEN) isAuthenticated = true;
                    }
                }

                if (!isAuthenticated) {
                    console.log('🚫 Unauthorized WebSocket connection attempt (HTTP fallback)');
                    wsClient.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
                    setTimeout(() => wsClient.close(), 100);
                    return;
                }

                console.log('📱 Client connected via HTTP fallback (Authenticated)');
                // Register in the main wss so broadcasts reach this client
                wss.clients.add(wsClient);
                wsClient.on('close', () => {
                    console.log('📱 Client disconnected (HTTP fallback)');
                    wss.clients.delete(wsClient);
                });
            });

            httpFallback.listen(httpPort, '0.0.0.0', () => {
                console.log(`📱 HTTP fallback on http://${localIP}:${httpPort} (for Tailscale)`);
            });
        }

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
