// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');
const attachBtn = document.getElementById('attachBtn');
const imageInput = document.getElementById('imageInput');
const imagePreviewBar = document.getElementById('imagePreviewBar');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0; // Timestamp until which we respect user scroll
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true; // Track if a chat is currently open
let lastSnapshotTime = 0;
let snapshotPending = false;
let snapshotTimer = null;
const SNAPSHOT_THROTTLE_MS = 2000; // Min time between snapshot updates
let pendingImages = []; // Images waiting to be sent

// --- Image Attachment ---
attachBtn.addEventListener('click', () => imageInput.click());

imageInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    files.forEach(file => {
        if (!file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = () => {
            pendingImages.push({ name: file.name, data: reader.result, type: file.type });
            renderImagePreviews();
        };
        reader.readAsDataURL(file);
    });
    imageInput.value = ''; // Reset so same file can be re-selected
});

function renderImagePreviews() {
    if (pendingImages.length === 0) {
        imagePreviewBar.style.display = 'none';
        imagePreviewBar.innerHTML = '';
        return;
    }
    imagePreviewBar.style.display = 'flex';
    imagePreviewBar.innerHTML = pendingImages.map((img, i) =>
        '<div class="image-preview-item">' +
        '<img src="' + img.data + '" alt="' + img.name + '">' +
        '<button class="image-preview-remove" onclick="removeImage(' + i + ')">×</button>' +
        '</div>'
    ).join('');
}

function removeImage(index) {
    pendingImages.splice(index, 1);
    renderImagePreviews();
}


// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    // Add ngrok skip warning header to all requests
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';

    try {
        const res = await fetch(url, options);
        if (res.status === 401) {
            console.log('[AUTH] Unauthorized, redirecting to login...');
            window.location.href = '/login.html';
            return new Promise(() => { }); // Halt execution
        }
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000; // 3 seconds of scroll protection

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        // Mode Sync (Fast/Planning) - Desktop is source of truth
        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        // Model Sync - Desktop is source of truth
        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }

        console.log('[SYNC] State refreshed from Desktop:', data);
    } catch (e) { console.error('[SYNC] Failed to sync state', e); }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    // Only show banner if currently on HTTP
    if (window.location.protocol === 'https:') return;

    // Check if user dismissed the banner before
    if (localStorage.getItem('sslBannerDismissed')) return;

    sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    btn.textContent = 'Generating...';
    btn.disabled = true;

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
        } else {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        btn.textContent = 'Error - Retry';
        btn.disabled = false;
    }
}

function dismissSslBanner() {
    sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

// Check SSL on load
checkSslStatus();
// --- Models ---
// Fallback model list (used if dynamic fetch fails)
const FALLBACK_MODELS = [
    "Gemini 3 Pro (High)",
    "Gemini 3 Pro (Low)",
    "Gemini 3 Flash",
    "Claude Opus 4.6",
    "Claude Opus 4.6 (Thinking)",
    "Claude Sonnet 4.6",
    "Claude Sonnet 4.5",
    "Claude Sonnet 4.5 (Thinking)",
    "Claude Opus 4.5 (Thinking)",
    "GPT-OSS 120B (Medium)"
];
let MODELS = [...FALLBACK_MODELS];

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot();
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'error' && data.message === 'Unauthorized') {
            window.location.href = '/login.html';
            return;
        }
        if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
            // Throttle snapshot updates to avoid performance issues on mobile
            const now = Date.now();
            const elapsed = now - lastSnapshotTime;
            if (elapsed >= SNAPSHOT_THROTTLE_MS) {
                lastSnapshotTime = now;
                loadSnapshot();
            } else if (!snapshotPending) {
                snapshotPending = true;
                clearTimeout(snapshotTimer);
                snapshotTimer = setTimeout(() => {
                    snapshotPending = false;
                    lastSnapshotTime = Date.now();
                    loadSnapshot();
                }, SNAPSHOT_THROTTLE_MS - elapsed);
            }
        }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- Post-process snapshot to make .md artifact links clickable ---
function makeArtifactLinksClickable() {
    // Find all links in the chat content
    const links = chatContent.querySelectorAll('a[href]');
    links.forEach(link => {
        const href = link.getAttribute('href') || '';
        // Match file:/// links to .md files in the brain directory
        if (href.endsWith('.md') && (href.includes('brain') || href.includes('.gemini'))) {
            // Extract the relative path from the brain directory
            const brainMatch = href.match(/brain[\\/](.+\.md)/);
            if (brainMatch) {
                const relativePath = brainMatch[1].replace(/\\/g, '/');
                link.setAttribute('href', '#');
                link.style.cssText = 'color: #60a5fa !important; cursor: pointer; text-decoration: underline; background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;';
                link.innerHTML = '📄 ' + link.textContent;
                link.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openMarkdownFile(relativePath); };
            }
        }
    });

    // Also find text nodes mentioning .md file paths and wrap them
    const walker = document.createTreeWalker(chatContent, NodeFilter.SHOW_TEXT, null, false);
    const textNodes = [];
    let node;
    while (node = walker.nextNode()) {
        if (node.textContent.match(/[\w/\\.-]+\.md/)) {
            textNodes.push(node);
        }
    }
    textNodes.forEach(textNode => {
        const text = textNode.textContent;
        // Match paths like brain/uuid/file.md or just file.md within artifact context
        const regex = /(?:brain[\\/])?([\w-]+[\\/][\w_.-]+\.md)/g;
        let match;
        const matches = [];
        while (match = regex.exec(text)) {
            if (text.includes('brain') || text.includes('.gemini') || text.includes('artifact')) {
                matches.push({ index: match.index, fullMatch: match[0], path: match[1] || match[0] });
            }
        }
        if (matches.length === 0) return;

        // Only process if in an element that isn't already a link
        if (textNode.parentElement && textNode.parentElement.tagName === 'A') return;

        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        matches.forEach(m => {
            if (m.index > lastIndex) {
                fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
            }
            const btn = document.createElement('a');
            btn.href = '#';
            btn.textContent = '📄 ' + m.path.split(/[\\/]/).pop();
            btn.style.cssText = 'color: #60a5fa; cursor: pointer; text-decoration: underline; background: rgba(59,130,246,0.1); padding: 2px 6px; border-radius: 4px;';
            btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); openMarkdownFile(m.path.replace(/\\/g, '/')); };
            fragment.appendChild(btn);
            lastIndex = m.index + m.fullMatch.length;
        });
        if (lastIndex < text.length) {
            fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
        textNode.parentNode.replaceChild(fragment, textNode);
    });
}

// --- Rendering ---
async function loadSnapshot() {
    try {
        // Add spin animation to refresh button (no forced reflow)
        const icon = refreshBtn.querySelector('svg');
        icon.classList.add('spin-anim');
        setTimeout(() => icon.classList.remove('spin-anim'), 600);

        const response = await fetchWithAuth('/snapshot');
        if (!response.ok) {
            if (response.status === 503) {
                // No snapshot available - likely no chat open
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        // Mark chat as open since we got a valid snapshot
        chatIsOpen = true;

        const data = await response.json();

        // Capture scroll state BEFORE updating content
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        // --- UPDATE STATS ---
        if (data.stats) {
            const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
            const nodes = data.stats.nodes;
            const statsText = document.getElementById('statsText');
            if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
        }

        // --- CSS INJECTION (Cached) ---
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const darkModeOverrides = '/* --- BASE SNAPSHOT CSS --- */\n' +
            data.css +
            '\n\n/* --- FORCE DARK MODE OVERRIDES --- */\n' +
            ':root {\n' +
            '    --bg-app: #0f172a;\n' +
            '    --text-main: #f8fafc;\n' +
            '    --text-muted: #94a3b8;\n' +
            '    --border-color: #334155;\n' +
            '}\n' +
            '\n' +
            '#conversation, #chat, #cascade {\n' +
            '    background-color: transparent !important;\n' +
            '    color: var(--text-main) !important;\n' +
            '    font-family: \'Inter\', system-ui, sans-serif !important;\n' +
            '    position: relative !important;\n' +
            '    height: auto !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '\n' +
            '#conversation *, #chat *, #cascade * {\n' +
            '    position: static !important;\n' +
            '}\n' +
            '\n' +
            '#conversation p, #chat p, #cascade p, #conversation h1, #chat h1, #cascade h1, #conversation h2, #chat h2, #cascade h2, #conversation h3, #chat h3, #cascade h3, #conversation h4, #chat h4, #cascade h4, #conversation h5, #chat h5, #cascade h5, #conversation span, #chat span, #cascade span, #conversation div, #chat div, #cascade div, #conversation li, #chat li, #cascade li {\n' +
            '    color: inherit !important;\n' +
            '}\n' +
            '\n' +
            '#conversation a, #chat a, #cascade a {\n' +
            '    color: #60a5fa !important;\n' +
            '    text-decoration: underline;\n' +
            '}\n' +
            '\n' +
            '/* Fix Inline Code - Ultra-compact */\n' +
            ':not(pre) > code {\n' +
            '    padding: 0px 2px !important;\n' +
            '    border-radius: 2px !important;\n' +
            '    background-color: rgba(255, 255, 255, 0.1) !important;\n' +
            '    font-size: 0.82em !important;\n' +
            '    line-height: 1 !important;\n' +
            '    white-space: normal !important;\n' +
            '}\n' +
            '\n' +
            'pre, code, .monaco-editor-background, [class*="terminal"] {\n' +
            '    background-color: #1e293b !important;\n' +
            '    color: #e2e8f0 !important;\n' +
            '    font-family: \'JetBrains Mono\', monospace !important;\n' +
            '    border-radius: 3px;\n' +
            '    border: 1px solid #334155;\n' +
            '}\n' +
            '                \n' +
            '/* Multi-line Code Block - Minimal */\n' +
            'pre {\n' +
            '    position: relative !important;\n' +
            '    white-space: pre-wrap !important; \n' +
            '    word-break: break-word !important;\n' +
            '    padding: 4px 6px !important;\n' +
            '    margin: 2px 0 !important;\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '}\n' +
            '                \n' +
            'pre.has-copy-btn {\n' +
            '    padding-right: 28px !important;\n' +
            '}\n' +
            '                \n' +
            '/* Single-line Code Block - Minimal */\n' +
            'pre.single-line-pre {\n' +
            '    display: inline-block !important;\n' +
            '    width: auto !important;\n' +
            '    max-width: 100% !important;\n' +
            '    padding: 0px 4px !important;\n' +
            '    margin: 0px !important;\n' +
            '    vertical-align: middle !important;\n' +
            '    background-color: #1e293b !important;\n' +
            '    font-size: 0.85em !important;\n' +
            '}\n' +
            '                \n' +
            'pre.single-line-pre > code {\n' +
            '    display: inline !important;\n' +
            '    white-space: nowrap !important;\n' +
            '}\n' +
            '                \n' +
            'pre:not(.single-line-pre) > code {\n' +
            '    display: block !important;\n' +
            '    width: 100% !important;\n' +
            '    overflow-x: auto !important;\n' +
            '    background: transparent !important;\n' +
            '    border: none !important;\n' +
            '    padding: 0 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn {\n' +
            '    position: absolute !important;\n' +
            '    top: 2px !important;\n' +
            '    right: 2px !important;\n' +
            '    background: rgba(30, 41, 59, 0.5) !important; /* Transparent bg */\n' +
            '    color: #94a3b8 !important;\n' +
            '    border: none !important;\n' +
            '    width: 24px !important; \n' +
            '    height: 24px !important;\n' +
            '    padding: 0 !important;\n' +
            '    cursor: pointer !important;\n' +
            '    display: flex !important;\n' +
            '    align-items: center !important;\n' +
            '    justify-content: center !important;\n' +
            '    border-radius: 4px !important;\n' +
            '    transition: all 0.2s ease !important;\n' +
            '    -webkit-tap-highlight-color: transparent !important;\n' +
            '    z-index: 10 !important;\n' +
            '    margin: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn:hover,\n' +
            '.mobile-copy-btn:focus {\n' +
            '    background: rgba(59, 130, 246, 0.2) !important;\n' +
            '    color: #60a5fa !important;\n' +
            '}\n' +
            '                \n' +
            '.mobile-copy-btn svg {\n' +
            '    width: 16px !important;\n' +
            '    height: 16px !important;\n' +
            '    stroke: currentColor !important;\n' +
            '    stroke-width: 2 !important;\n' +
            '    fill: none !important;\n' +
            '}\n' +
            '                \n' +
            'blockquote {\n' +
            '    border-left: 3px solid #3b82f6 !important;\n' +
            '    background: rgba(59, 130, 246, 0.1) !important;\n' +
            '    color: #cbd5e1 !important;\n' +
            '    padding: 8px 12px !important;\n' +
            '    margin: 8px 0 !important;\n' +
            '}\n' +
            '\n' +
            'table {\n' +
            '    border-collapse: collapse !important;\n' +
            '    width: 100% !important;\n' +
            '    border: 1px solid #334155 !important;\n' +
            '}\n' +
            'th, td {\n' +
            '    border: 1px solid #334155 !important;\n' +
            '    padding: 8px !important;\n' +
            '    color: #e2e8f0 !important;\n' +
            '}\n' +
            '\n' +
            '::-webkit-scrollbar {\n' +
            '    width: 0 !important;\n' +
            '}\n' +
            '                \n' +
            '[style*=\"background-color: rgb(255, 255, 255)\"],\n' +
            '[style*=\"background-color: white\"],\n' +
            '[style*=\"background: white\"] {\n' +
            '    background-color: transparent !important;\n' +
            '}';
        styleTag.textContent = darkModeOverrides;
        chatContent.innerHTML = data.html;

        // Make .md artifact links clickable to open in viewer
        makeArtifactLinksClickable();

        // Add mobile copy buttons to all code blocks
        addMobileCopyButtons();

        // Smart scroll behavior: respect user scroll, only auto-scroll when appropriate
        if (isUserScrollLocked) {
            // User recently scrolled - try to maintain their approximate position
            // Use percentage-based restoration for better accuracy
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            const newScrollPos = chatContainer.scrollHeight * scrollPercent;
            chatContainer.scrollTop = newScrollPos;
        } else if (isNearBottom || scrollPos === 0) {
            // User was at bottom or hasn't scrolled - auto scroll to bottom
            scrollToBottom();
        } else {
            // Preserve exact scroll position
            chatContainer.scrollTop = scrollPos;
        }

    } catch (err) {
        console.error(err);
    }
}

// --- Mobile Code Block Copy Functionality ---
function addMobileCopyButtons() {
    // Find all pre elements (code blocks) in the chat
    const codeBlocks = chatContent.querySelectorAll('pre');

    codeBlocks.forEach((pre, index) => {
        // Skip if already has our button
        if (pre.querySelector('.mobile-copy-btn')) return;

        // Get the code text
        const codeElement = pre.querySelector('code') || pre;
        const textToCopy = (codeElement.textContent || codeElement.innerText).trim();

        // Check if there's a newline character in the TRIMMED text
        // This ensures single-line blocks with trailing newlines don't get buttons
        const hasNewline = /\n/.test(textToCopy);

        // If it's a single line code block, don't add the copy button
        if (!hasNewline) {
            pre.classList.remove('has-copy-btn');
            pre.classList.add('single-line-pre');
            return;
        }

        // Add class for padding
        pre.classList.remove('single-line-pre');
        pre.classList.add('has-copy-btn');

        // Create the copy button (icon only)
        const copyBtn = document.createElement('button');
        copyBtn.className = 'mobile-copy-btn';
        copyBtn.setAttribute('data-code-index', index);
        copyBtn.setAttribute('aria-label', 'Copy code');
        copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>
            `;

        // Add click handler for copy
        copyBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();

            const success = await copyToClipboard(textToCopy);

            if (success) {
                // Visual feedback - show checkmark
                copyBtn.classList.add('copied');
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            `;

                // Reset after 2 seconds
                setTimeout(() => {
                    copyBtn.classList.remove('copied');
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            } else {
                // Show X icon briefly on error
                copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
            `;
                setTimeout(() => {
                    copyBtn.innerHTML = `
            <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
            `;
                }, 2000);
            }
        });

        // Insert button into pre element
        pre.appendChild(copyBtn);
    });
}

// --- Cross-platform Clipboard Copy ---
async function copyToClipboard(text) {
    // Method 1: Modern Clipboard API (works on HTTPS or localhost)
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            console.log('[COPY] Success via Clipboard API');
            return true;
        } catch (err) {
            console.warn('[COPY] Clipboard API failed:', err);
        }
    }

    // Method 2: Fallback using execCommand (works on HTTP, older browsers)
    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;

        // Avoid scrolling to bottom on iOS
        textArea.style.position = 'fixed';
        textArea.style.top = '0';
        textArea.style.left = '0';
        textArea.style.width = '2em';
        textArea.style.height = '2em';
        textArea.style.padding = '0';
        textArea.style.border = 'none';
        textArea.style.outline = 'none';
        textArea.style.boxShadow = 'none';
        textArea.style.background = 'transparent';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);

        // iOS specific handling
        if (navigator.userAgent.match(/ipad|iphone/i)) {
            const range = document.createRange();
            range.selectNodeContents(textArea);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            textArea.setSelectionRange(0, text.length);
        } else {
            textArea.select();
        }

        const success = document.execCommand('copy');
        document.body.removeChild(textArea);

        if (success) {
            console.log('[COPY] Success via execCommand fallback');
            return true;
        }
    } catch (err) {
        console.warn('[COPY] execCommand fallback failed:', err);
    }

    // Method 3: For Android WebView or restricted contexts
    // Show the text in a selectable modal if all else fails
    console.error('[COPY] All copy methods failed');
    return false;
}

function scrollToBottom() {
    chatContainer.scrollTo({
        top: chatContainer.scrollHeight,
        behavior: 'smooth'
    });
}

// --- Inputs ---
async function sendMessage() {
    const message = messageInput.value.trim();
    const images = [...pendingImages];
    if (!message && images.length === 0) return;

    // Optimistic UI updates
    messageInput.value = ''; // Clear immediately
    messageInput.style.height = 'auto'; // Reset height
    messageInput.blur(); // Close keyboard on mobile immediately
    pendingImages = [];
    renderImagePreviews();

    sendBtn.disabled = true;
    sendBtn.style.opacity = '0.5';

    try {
        // If no chat is open, start a new one first
        if (!chatIsOpen) {
            const newChatRes = await fetchWithAuth('/new-chat', { method: 'POST' });
            const newChatData = await newChatRes.json();
            if (newChatData.success) {
                await new Promise(r => setTimeout(r, 800));
                chatIsOpen = true;
            }
        }

        // Upload images first (paste into editor)
        for (const img of images) {
            try {
                const uploadRes = await fetchWithAuth('/upload-image', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: img.data, filename: img.name })
                });
                const uploadData = await uploadRes.json();
                if (!uploadData.success) {
                    console.warn('Image upload failed:', uploadData.error || 'Unknown error');
                    // Brief visual feedback - flash the send button red
                    sendBtn.style.background = '#ef4444';
                    setTimeout(() => { sendBtn.style.background = ''; }, 1500);
                }
            } catch (uploadErr) {
                console.error('Image upload error:', uploadErr);
                sendBtn.style.background = '#ef4444';
                setTimeout(() => { sendBtn.style.background = ''; }, 1500);
            }
            await new Promise(r => setTimeout(r, 300)); // Brief pause between images
        }

        // Send text message (if any)
        if (message) {
            const res = await fetchWithAuth('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message })
            });
            if (!res.ok) {
                console.warn('Send response not ok:', await res.json().catch(() => ({})));
            }
        } else if (images.length > 0) {
            // If only images, press Enter to send
            await fetchWithAuth('/send-enter', { method: 'POST' });
        }

        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 800);
        setTimeout(checkChatStatus, 1000);
    } catch (e) {
        console.error('Send error:', e);
        setTimeout(loadSnapshot, 500);
    } finally {
        sendBtn.disabled = false;
        sendBtn.style.opacity = '1';
    }
}

// --- Event Listeners ---
sendBtn.addEventListener('click', sendMessage);

refreshBtn.addEventListener('click', () => {
    // Refresh both Chat and State (Mode/Model)
    loadSnapshot();
    fetchAppState(); // PRIORITY: Sync from Desktop
});

messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

messageInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
});

// --- Scroll Sync to Desktop ---
let scrollSyncTimeout = null;
let lastScrollSync = 0;
const SCROLL_SYNC_DEBOUNCE = 150; // ms between scroll syncs
let snapshotReloadPending = false;

async function syncScrollToDesktop() {
    const scrollPercent = chatContainer.scrollTop / (chatContainer.scrollHeight - chatContainer.clientHeight);
    try {
        await fetchWithAuth('/remote-scroll', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scrollPercent })
        });

        // After scrolling desktop, reload snapshot to get newly visible content
        // (Antigravity uses virtualized scrolling - only visible messages are in DOM)
        if (!snapshotReloadPending) {
            snapshotReloadPending = true;
            setTimeout(() => {
                loadSnapshot();
                snapshotReloadPending = false;
            }, 300);
        }
    } catch (e) {
        console.log('Scroll sync failed:', e.message);
    }
}

chatContainer.addEventListener('scroll', () => {
    userIsScrolling = true;
    // Set a lock to prevent auto-scroll jumping for a few seconds
    userScrollLockUntil = Date.now() + USER_SCROLL_LOCK_DURATION;
    clearTimeout(idleTimer);

    const isNearBottom = chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 120;
    if (isNearBottom) {
        scrollToBottomBtn.classList.remove('show');
        // If user scrolled to bottom, clear the lock so auto-scroll works
        userScrollLockUntil = 0;
    } else {
        scrollToBottomBtn.classList.add('show');
    }

    // Debounced scroll sync to desktop
    const now = Date.now();
    if (now - lastScrollSync > SCROLL_SYNC_DEBOUNCE) {
        lastScrollSync = now;
        clearTimeout(scrollSyncTimeout);
        scrollSyncTimeout = setTimeout(syncScrollToDesktop, 100);
    }

    idleTimer = setTimeout(() => {
        userIsScrolling = false;
        autoRefreshEnabled = true;
    }, 5000);
});

scrollToBottomBtn.addEventListener('click', () => {
    userIsScrolling = false;
    userScrollLockUntil = 0; // Clear lock so auto-scroll works again
    scrollToBottom();
});

// --- Quick Actions ---
function quickAction(text) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    messageInput.focus();
}

// --- Stop Logic ---
stopBtn.addEventListener('click', async () => {
    stopBtn.style.opacity = '0.5';
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // alert('Stopped');
        } else {
            // alert('Error: ' + data.error);
        }
    } catch (e) { }
    setTimeout(() => stopBtn.style.opacity = '1', 500);
});

// --- New Chat Logic ---
async function startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            // Reload snapshot to show new empty chat
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1000);
            setTimeout(checkChatStatus, 1500);
        } else {
            console.error('Failed to start new chat:', data.error);
        }
    } catch (e) {
        console.error('New chat error:', e);
    }

    setTimeout(() => {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
    }, 500);
}

newChatBtn.addEventListener('click', startNewChat);

// --- Chat History Logic ---
async function showChatHistory() {
    const historyLayer = document.getElementById('historyLayer');
    const historyList = document.getElementById('historyList');

    // Show loading state
    historyList.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading conversations...</p>
        </div>
    `;
    historyLayer.classList.add('show');

    // Model name pattern - filter these out from conversation list
    const MODEL_NAME_RE = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\b/i;

    // Helper to fetch and render history, with optional retry
    const fetchHistory = async (isRetry = false) => {
        try {
            const res = await fetchWithAuth('/chat-history');
            const data = await res.json();

            // Filter out model names that were incorrectly scraped as conversations
            if (data.chats && data.chats.length > 0) {
                data.chats = data.chats.filter(chat => !MODEL_NAME_RE.test(chat.title));
            }

            // If no chats found and not a retry, auto-retry once after a delay
            if (!isRetry && (!data.chats || data.chats.length === 0) && !data.error) {
                historyList.innerHTML = `
                    <div style="padding: 40px 20px; text-align: center; color: white;">
                        <div class="loading-spinner"></div>
                        <p style="margin-top: 10px; opacity: 0.7;">Searching for conversations...</p>
                    </div>
                `;
                await new Promise(r => setTimeout(r, 1500));
                return fetchHistory(true);
            }

            if (data.error || !data.chats || data.chats.length === 0) {
                historyList.innerHTML = `
                    <div style="padding: 40px 20px; text-align: center; color: white;">
                        <div style="font-size: 24px; margin-bottom: 10px;">💬</div>
                        <div style="font-weight: 500; margin-bottom: 5px;">${data.error ? 'Could not load history' : 'No conversations found'}</div>
                        <div style="font-size: 13px; opacity: 0.7; margin-bottom: 20px;">${data.error || 'Send at least one message in a conversation for it to appear here.'}</div>
                        <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none;">
                            Start New Conversation
                        </div>
                    </div>
                `;
            } else {
                let html = '';
                data.chats.forEach(chat => {
                    const safeTitle = escapeHtml(chat.title);
                    const isPinned = pinnedTabs.some(t => t.title === chat.title);
                    html += `
                        <div class="history-item" style="gap: 8px;">
                            <div style="flex: 1; min-width: 0; cursor: pointer;" onclick="selectChat('${safeTitle.replace(/'/g, "\\\\'")}'); hideChatHistory();">
                                <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${safeTitle}</div>
                                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${escapeHtml(chat.date || '')}</div>
                            </div>
                            <button class="pin-btn ${isPinned ? 'pinned' : ''}" onclick="event.stopPropagation(); togglePinTab('${safeTitle.replace(/'/g, "\\\'")}'); this.classList.toggle('pinned');" title="${isPinned ? 'Unpin' : 'Pin to tabs'}">
                                ${isPinned ? '⭐' : '📌'}
                            </button>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0; cursor: pointer;" onclick="selectChat('${safeTitle.replace(/'/g, "\\\'")}'); hideChatHistory();">
                                <polyline points="9 18 15 12 9 6"></polyline>
                            </svg>
                        </div>
                    `;
                });
                html += `
                    <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none; margin-top: 12px;">
                        + Start New Conversation
                    </div>
                `;
                historyList.innerHTML = html;
            }
        } catch (e) {
            console.error('Chat history error:', e);
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: white;">
                    <div style="font-size: 24px; margin-bottom: 10px;">⚠️</div>
                    <div style="font-weight: 500; margin-bottom: 5px;">Connection Error</div>
                    <div style="font-size: 13px; opacity: 0.7;">Could not reach the server. Please try again.</div>
                    <br>
                    <div class="history-item new-chat-item" onclick="hideChatHistory(); startNewChat();" style="justify-content: center; background: var(--accent); color: white; border:none;">
                        Start New Conversation
                    </div>
                </div>
            `;
        }
    };

    await fetchHistory();
    setTimeout(() => historyBtn.style.opacity = '1', 300);
}

function hideChatHistory() {
    historyLayer.classList.remove('show');
}

historyBtn.addEventListener('click', showChatHistory);

// --- Select Chat from History ---
async function selectChat(title) {
    try {
        const res = await fetchWithAuth('/select-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        const data = await res.json();

        if (data.success) {
            // Auto-add as a tab when successfully selected
            if (typeof addTab === 'function') addTab(title);
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(checkChatStatus, 1000);
        } else {
            console.error('Failed to select chat:', data.error);
        }
    } catch (e) {
        console.error('Select chat error:', e);
    }
}

// --- Check Chat Status ---
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();

        chatIsOpen = data.hasChat || data.editorFound;

        if (!chatIsOpen) {
            showEmptyState();
        }
    } catch (e) {
        console.error('Chat status check failed:', e);
    }
}

// --- Empty State (No Chat Open) ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                <line x1="9" y1="10" x2="15" y2="10"></line>
            </svg>
            <h2>No Chat Open</h2>
            <p>Start a new conversation or select one from your history to begin chatting.</p>
            <button class="empty-state-btn" onclick="startNewChat()">
                Start New Conversation
            </button>
        </div>
    `;
}

// --- Utility: Escape HTML ---
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Settings Logic ---


function openModal(title, options, onSelect) {
    modalTitle.textContent = title;
    modalList.innerHTML = '';
    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'modal-option';
        div.textContent = opt;
        div.onclick = () => {
            onSelect(opt);
            closeModal();
        };
        modalList.appendChild(div);
    });
    modalOverlay.classList.add('show');
}

function closeModal() {
    modalOverlay.classList.remove('show');
}

modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
};

modeBtn.addEventListener('click', () => {
    openModal('Select Mode', ['Fast', 'Planning'], async (mode) => {
        modeText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode })
            });
            const data = await res.json();
            if (data.success) {
                currentMode = mode;
                modeText.textContent = mode;
                modeBtn.classList.toggle('active', mode === 'Planning');
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modeText.textContent = currentMode;
            }
        } catch (e) {
            modeText.textContent = currentMode;
        }
    });
});

modelBtn.addEventListener('click', () => {
    openModal('Select Model', MODELS, async (model) => {
        const prev = modelText.textContent;
        modelText.textContent = 'Setting...';
        try {
            const res = await fetchWithAuth('/set-model', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model })
            });
            const data = await res.json();
            if (data.success) {
                modelText.textContent = model;
            } else {
                alert('Error: ' + (data.error || 'Unknown'));
                modelText.textContent = prev;
            }
        } catch (e) {
            modelText.textContent = prev;
        }
    });
});

// --- Viewport / Keyboard Handling ---
// iOS: When keyboard opens, visualViewport shrinks. We resize body to match
// and prevent the default iOS page scroll that hides content.
if (window.visualViewport) {
    let resizeTimeout = null;

    function handleViewportResize() {
        // Prevent iOS from scrolling the page behind the keyboard
        window.scrollTo(0, 0);

        // Match body height to visible area
        const vh = window.visualViewport.height;
        document.body.style.height = vh + 'px';
    }

    window.visualViewport.addEventListener('resize', () => {
        // Debounce to avoid layout thrashing during keyboard animation
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(handleViewportResize, 80);
    });

    handleViewportResize(); // Init
} else {
    // Fallback for older browsers without visualViewport support
    window.addEventListener('resize', () => {
        document.body.style.height = window.innerHeight + 'px';
    });
    document.body.style.height = window.innerHeight + 'px'; // Init
}

// --- Remote Click Logic (General) ---
// Handles taps on ANY interactive element in the snapshot:
// buttons, links, details/summary, thought toggles, etc.
chatContainer.addEventListener('click', async (e) => {
    // Find the nearest interactive element
    const target = e.target.closest('button, a, summary, details, [role="button"], [onclick]');

    // Also check for thought/thinking toggles in divs/spans
    const thoughtTarget = e.target.closest('div, span, p, summary');

    let clickTarget = null;
    let clickText = '';
    let clickSelector = '';

    if (target) {
        // Direct interactive element (button, link, summary)
        clickTarget = target;
        clickText = (target.innerText || target.textContent || '').trim();
        clickSelector = target.tagName.toLowerCase();
    } else if (thoughtTarget) {
        // Check if it's a thought/thinking toggle
        const text = (thoughtTarget.innerText || '').trim();
        if (/Thought|Thinking/i.test(text) && text.length < 500) {
            clickTarget = thoughtTarget;
            clickText = text;
            clickSelector = thoughtTarget.tagName.toLowerCase();
        }
    }

    if (!clickTarget || !clickText) return;

    // Ignore clicks on very long text (probably content, not a button)
    const firstLine = clickText.split('\n')[0].trim();
    if (firstLine.length > 200) return;

    // Visual feedback - briefly dim and highlight
    clickTarget.style.opacity = '0.5';
    clickTarget.style.outline = '2px solid #3b82f6';
    setTimeout(() => {
        clickTarget.style.opacity = '1';
        clickTarget.style.outline = '';
    }, 400);

    try {
        const response = await fetchWithAuth('/remote-click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                selector: clickSelector,
                index: 0,
                textContent: firstLine
            })
        });

        // Reload snapshot to reflect the click result
        setTimeout(loadSnapshot, 400);
        setTimeout(loadSnapshot, 800);
        setTimeout(loadSnapshot, 1500);
    } catch (e) {
        console.error('Remote click failed:', e);
    }
});

// --- Markdown File Viewer ---
const filesBtn = document.getElementById('filesBtn');
const filesLayer = document.getElementById('filesLayer');
const filesContent = document.getElementById('filesContent');
const filesTitle = document.getElementById('filesTitle');
const filesBackBtn = document.getElementById('filesBackBtn');
let filesNavStack = []; // navigation stack for back button
let filesCurrentDir = '';
let filesViewingFile = false;

// Simple markdown to HTML renderer
function renderMarkdown(md) {
    let html = md;

    // Escape HTML
    html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
    });

    // Headers (# to ######)
    html = html.replace(/^######\s+(.+)$/gm, '<h6 class="md-h6">$1</h6>');
    html = html.replace(/^#####\s+(.+)$/gm, '<h5 class="md-h5">$1</h5>');
    html = html.replace(/^####\s+(.+)$/gm, '<h4 class="md-h4">$1</h4>');
    html = html.replace(/^###\s+(.+)$/gm, '<h3 class="md-h3">$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2 class="md-h2">$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1 class="md-h1">$1</h1>');

    // Horizontal rules
    html = html.replace(/^---+$/gm, '<hr class="md-hr">');

    // Blockquotes (> ...)
    html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote class="md-blockquote">$1</blockquote>');

    // Unordered lists (- item or * item)
    html = html.replace(/^[\-\*]\s+\[x\]\s+(.+)$/gm, '<div class="md-list-item md-done">✅ $1</div>');
    html = html.replace(/^[\-\*]\s+\[\/\]\s+(.+)$/gm, '<div class="md-list-item md-progress">🔄 $1</div>');
    html = html.replace(/^[\-\*]\s+\[\s?\]\s+(.+)$/gm, '<div class="md-list-item md-todo">⬜ $1</div>');
    html = html.replace(/^[\-\*]\s+(.+)$/gm, '<div class="md-list-item">• $1</div>');

    // Sub-items (indented - item)
    html = html.replace(/^\s{2,}[\-\*]\s+(.+)$/gm, '<div class="md-list-item md-sub-item">  ◦ $1</div>');

    // Bold (**text** or __text__)
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

    // Italic (*text* or _text_)
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.+?)_/g, '<em>$1</em>');

    // Inline code (`code`)
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

    // Links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank">$1</a>');

    // Line breaks (double newline = paragraph break)
    html = html.replace(/\n\n/g, '<br><br>');
    html = html.replace(/\n/g, '<br>');

    return html;
}

async function showFilesView(dir = '') {
    filesCurrentDir = dir;
    filesViewingFile = false;
    filesLayer.classList.add('show');

    // Update title based on current directory
    if (dir) {
        const parts = dir.split(/[\\/]/);
        const shortId = parts[0]?.substring(0, 8) + '...';
        filesTitle.textContent = parts.length > 1 ? parts[parts.length - 1] : shortId;
    } else {
        filesTitle.textContent = 'Artifacts';
    }

    filesContent.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading files...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth(`/api/files?dir=${encodeURIComponent(dir)}`);
        const data = await res.json();

        if (data.error) {
            filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">${escapeHtml(data.error)}</div>`;
            return;
        }

        let html = '';

        // Show directories
        if (data.dirs && data.dirs.length > 0) {
            for (const d of data.dirs) {
                const dirPath = dir ? `${dir}/${d.name}` : d.name;
                const shortName = d.name.length > 20 ? d.name.substring(0, 8) + '...' : d.name;
                html += `
                    <div class="history-item" onclick="filesNavStack.push('${escapeHtml(dir)}'); showFilesView('${escapeHtml(dirPath)}')">
                        <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 20px;">📁</span>
                            <div>
                                <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(shortName)}</div>
                                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${d.mdCount} file${d.mdCount !== 1 ? 's' : ''}</div>
                            </div>
                        </div>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0;">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                `;
            }
        }

        // Show files
        if (data.files && data.files.length > 0) {
            for (const f of data.files) {
                const filePath = dir ? `${dir}/${f.name}` : f.name;
                const sizeKb = (f.size / 1024).toFixed(1);
                const modDate = new Date(f.modified).toLocaleDateString();
                html += `
                    <div class="history-item" onclick="openMarkdownFile('${escapeHtml(filePath)}')">
                        <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 20px;">📄</span>
                            <div>
                                <div style="font-weight: 600; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(f.name)}</div>
                                <div style="font-size: 12px; color: #94a3b8; margin-top: 2px;">${sizeKb} KB · ${modDate}</div>
                            </div>
                        </div>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity: 0.4; flex-shrink: 0;">
                            <polyline points="9 18 15 12 9 6"></polyline>
                        </svg>
                    </div>
                `;
            }
        }

        if (!html) {
            html = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">No markdown files found</div>`;
        }

        filesContent.innerHTML = html;
    } catch (e) {
        console.error('Files listing error:', e);
        filesContent.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: white; opacity: 0.7;">Error loading files</div>`;
    }
}

async function openMarkdownFile(filePath) {
    filesViewingFile = true;
    filesNavStack.push(filesCurrentDir);
    const fileName = filePath.split(/[\\/]/).pop();
    filesTitle.textContent = fileName;

    filesContent.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; color: white;">
            <div class="loading-spinner"></div>
            <p style="margin-top: 10px; opacity: 0.7;">Loading ${escapeHtml(fileName)}...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth(`/api/file-content?path=${encodeURIComponent(filePath)}`);
        const data = await res.json();

        if (data.error) {
            filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">${escapeHtml(data.error)}</div>`;
            return;
        }

        const rendered = renderMarkdown(data.content);
        filesContent.innerHTML = `<div class="md-viewer">${rendered}</div>`;
    } catch (e) {
        console.error('File read error:', e);
        filesContent.innerHTML = `<div style="padding: 20px; color: #ef4444;">Error reading file</div>`;
    }
}

function hideFilesView() {
    filesLayer.classList.remove('show');
    filesNavStack = [];
    filesViewingFile = false;
}

filesBtn.addEventListener('click', () => {
    filesNavStack = [];
    showFilesView('');
});

filesBackBtn.addEventListener('click', () => {
    if (filesNavStack.length > 0) {
        const prevDir = filesNavStack.pop();
        showFilesView(prevDir);
    } else {
        hideFilesView();
    }
});

// --- Init ---
connectWebSocket();
// Sync state initially and every 5 seconds to keep phone in sync with desktop changes
fetchAppState();
setInterval(fetchAppState, 5000);

// Check chat status initially and periodically
checkChatStatus();
setInterval(checkChatStatus, 10000); // Check every 10 seconds

// ===== WINDOW SWITCHER (Multi-Window Support) =====
const windowSwitcher = document.getElementById('windowSwitcher');
const windowSwitcherInner = document.getElementById('windowSwitcherInner');
let currentWindows = [];
let currentActiveWindowId = null;

async function fetchWindows() {
    try {
        const res = await fetchWithAuth('/windows');
        if (!res.ok) return;
        const data = await res.json();
        currentWindows = data.windows || [];
        currentActiveWindowId = data.activeWindowId;
        renderWindows();
    } catch (e) { /* silent */ }
}

function getOrderedWindows() {
    // Apply user-defined order from localStorage, Manager always first
    const savedOrder = JSON.parse(localStorage.getItem('ag_window_order') || '[]');
    const manager = currentWindows.filter(w => w.isManager);
    const projects = currentWindows.filter(w => !w.isManager);

    if (savedOrder.length > 0) {
        // Sort projects by saved order, unknown items go to end
        projects.sort((a, b) => {
            const ai = savedOrder.indexOf(a.id);
            const bi = savedOrder.indexOf(b.id);
            if (ai === -1 && bi === -1) return a.projectName.localeCompare(b.projectName);
            if (ai === -1) return 1;
            if (bi === -1) return -1;
            return ai - bi;
        });
    }
    return [...manager, ...projects];
}

function saveWindowOrder() {
    const order = getOrderedWindows().filter(w => !w.isManager).map(w => w.id);
    localStorage.setItem('ag_window_order', JSON.stringify(order));
}

function moveWindowTab(windowId, direction) {
    const projects = currentWindows.filter(w => !w.isManager);
    const idx = projects.findIndex(w => w.id === windowId);
    if (idx === -1) return;

    if (direction === 'left' && idx > 0) {
        [projects[idx], projects[idx - 1]] = [projects[idx - 1], projects[idx]];
    } else if (direction === 'right' && idx < projects.length - 1) {
        [projects[idx], projects[idx + 1]] = [projects[idx + 1], projects[idx]];
    } else if (direction === 'first') {
        const item = projects.splice(idx, 1)[0];
        projects.unshift(item);
    }

    // Save new order
    localStorage.setItem('ag_window_order', JSON.stringify(projects.map(w => w.id)));
    renderWindows();
}

let longPressTimer = null;

function renderWindows() {
    // Only show switcher if more than 1 window
    if (currentWindows.length <= 1) {
        windowSwitcher.style.display = 'none';
        return;
    }
    windowSwitcher.style.display = 'flex';
    const ordered = getOrderedWindows();
    windowSwitcherInner.innerHTML = ordered.map(win => {
        const isActive = win.id === currentActiveWindowId;
        const managerClass = win.isManager ? ' manager' : '';
        return `<div class="window-tab${managerClass}${isActive ? ' active' : ''}" 
            data-window-id="${win.id}" data-is-manager="${win.isManager}">
            <span class="window-dot"></span>
            <span>${escapeHtml(win.projectName)}</span>
        </div>`;
    }).join('');

    // Add tap + long-press handlers
    windowSwitcherInner.querySelectorAll('.window-tab').forEach(tab => {
        const winId = tab.dataset.windowId;
        const isManager = tab.dataset.isManager === 'true';

        tab.addEventListener('click', () => switchWindow(winId));

        // Long-press for reorder (only on project tabs, not Manager)
        if (!isManager) {
            tab.addEventListener('touchstart', (e) => {
                longPressTimer = setTimeout(() => {
                    e.preventDefault();
                    showReorderMenu(winId, tab);
                }, 500);
            }, { passive: false });
            tab.addEventListener('touchend', () => clearTimeout(longPressTimer));
            tab.addEventListener('touchmove', () => clearTimeout(longPressTimer));
        }
    });

    // Show/hide workspace opener based on whether Manager is active
    if (typeof updateManagerUI === 'function') updateManagerUI();
}

function showReorderMenu(windowId, tabEl) {
    // Remove existing menu if any
    document.querySelectorAll('.reorder-menu').forEach(m => m.remove());

    const menu = document.createElement('div');
    menu.className = 'reorder-menu';
    menu.style.cssText = `
        position: fixed; z-index: 9999; 
        background: #1e293b; border: 1px solid #334155; border-radius: 8px;
        padding: 4px; box-shadow: 0 8px 24px rgba(0,0,0,0.5);
        display: flex; gap: 2px;
    `;

    const rect = tabEl.getBoundingClientRect();
    menu.style.left = rect.left + 'px';
    menu.style.top = (rect.bottom + 4) + 'px';

    const actions = [
        { label: '⬅️', action: 'left' },
        { label: '⬆️ First', action: 'first' },
        { label: '➡️', action: 'right' },
    ];

    actions.forEach(({ label, action }) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = `
            padding: 6px 10px; background: transparent; border: none;
            color: #e2e8f0; font-size: 13px; cursor: pointer; border-radius: 6px;
        `;
        btn.addEventListener('click', () => {
            moveWindowTab(windowId, action);
            menu.remove();
        });
        menu.appendChild(btn);
    });

    document.body.appendChild(menu);
    // Auto-dismiss on tap outside
    setTimeout(() => {
        document.addEventListener('click', function dismiss() {
            menu.remove();
            document.removeEventListener('click', dismiss);
        }, { once: true });
    }, 100);
}

async function switchWindow(windowId) {
    if (windowId === currentActiveWindowId) return;

    // Save current tabs for the old window
    if (currentActiveWindowId) {
        localStorage.setItem('ag_tabs_' + currentActiveWindowId, JSON.stringify(pinnedTabs));
    }

    // Optimistic UI update
    currentActiveWindowId = windowId;
    renderWindows();

    try {
        const res = await fetchWithAuth('/switch-window', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId })
        });
        const data = await res.json();
        if (data.success) {
            console.log('🪟 Switched to:', data.projectName);

            // Load tabs for the new window
            pinnedTabs = JSON.parse(localStorage.getItem('ag_tabs_' + windowId) || '[]');
            activeTabTitle = null;
            renderTabs();

            // Refresh everything for the new window
            loadSnapshot();
            fetchAppState();
            checkChatStatus();
            detectCurrentConversation();
        }
    } catch (e) {
        console.error('Window switch failed:', e);
    }
}

async function openWorkspace(folderPath) {
    if (!folderPath) return;
    try {
        const res = await fetchWithAuth('/open-workspace', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderPath })
        });
        const data = await res.json();
        if (data.success) {
            console.log('📂 Opening workspace:', folderPath);
            // Save to recent workspaces
            const recents = JSON.parse(localStorage.getItem('ag_recent_workspaces') || '[]');
            if (!recents.includes(folderPath)) {
                recents.unshift(folderPath);
                if (recents.length > 10) recents.pop();
                localStorage.setItem('ag_recent_workspaces', JSON.stringify(recents));
            }
            // Poll for new window to appear
            setTimeout(fetchWindows, 3000);
            setTimeout(fetchWindows, 6000);
        }
    } catch (e) {
        console.error('Open workspace failed:', e);
    }
}

// --- Workspace Opener UI ---
const workspaceOpener = document.getElementById('workspaceOpener');
const workspacePathInput = document.getElementById('workspacePath');
const workspaceOpenBtn = document.getElementById('workspaceOpenBtn');
const workspaceProjects = document.getElementById('workspaceProjects');
const quickActionsBar = document.getElementById('quickActionsBar');
const inputSection = document.querySelector('.input-section');
let availableProjects = [];

function updateManagerUI() {
    const isManagerActive = currentWindows.some(w => w.id === currentActiveWindowId && w.isManager);
    if (isManagerActive && currentWindows.length > 1) {
        workspaceOpener.style.display = 'block';
        quickActionsBar.style.display = 'none';
        inputSection.style.display = 'none';
        fetchProjectList();
    } else {
        workspaceOpener.style.display = 'none';
        quickActionsBar.style.display = '';
        inputSection.style.display = '';
    }
}

async function fetchProjectList() {
    try {
        const res = await fetchWithAuth('/list-projects');
        const data = await res.json();
        availableProjects = data.projects || [];
        renderProjectTiles();
    } catch (e) {
        workspaceProjects.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 8px;">Could not load projects</div>';
    }
}

function renderProjectTiles() {
    const openNames = currentWindows.filter(w => !w.isManager).map(w => w.projectName.toLowerCase());

    workspaceProjects.innerHTML = availableProjects.map((proj, idx) => {
        const isOpen = openNames.includes(proj.name.toLowerCase());
        return `<div class="project-tile${isOpen ? ' already-open' : ''}" data-proj-idx="${idx}">
            <span class="tile-icon">${isOpen ? '✅' : '📁'}</span>
            <span>${escapeHtml(proj.name)}</span>
        </div>`;
    }).join('');

    // Attach click handlers using JS references (preserves backslash paths)
    workspaceProjects.querySelectorAll('.project-tile:not(.already-open)').forEach(tile => {
        tile.addEventListener('click', () => {
            const idx = parseInt(tile.dataset.projIdx);
            const proj = availableProjects[idx];
            if (proj) openWorkspace(proj.path);
        });
    });
}

workspaceOpenBtn.addEventListener('click', () => {
    let path = workspacePathInput.value.trim();
    if (!path) return;
    // Auto-prepend base path if just a folder name
    if (!path.includes('\\') && !path.includes('/')) {
        path = 'C:\\Proyects\\' + path;
    }
    openWorkspace(path);
    workspacePathInput.value = '';
});

workspacePathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        let path = workspacePathInput.value.trim();
        if (!path) return;
        if (!path.includes('\\') && !path.includes('/')) {
            path = 'C:\\Proyects\\' + path;
        }
        openWorkspace(path);
        workspacePathInput.value = '';
    }
});

// --- Workflow Picker ---
let cachedWorkflows = null;

async function showWorkflowPicker() {
    const picker = document.getElementById('workflowPicker');
    const list = document.getElementById('workflowList');
    // Toggle: if already open, close it
    if (picker.style.display === 'block') {
        picker.style.display = 'none';
        return;
    }
    picker.style.display = 'block';

    if (cachedWorkflows) {
        renderWorkflowList(cachedWorkflows);
        return;
    }

    list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px; padding: 4px;">Loading workflows...</div>';
    try {
        const res = await fetchWithAuth('/list-workflows');
        const data = await res.json();
        cachedWorkflows = data.workflows || [];
        renderWorkflowList(cachedWorkflows);
    } catch (e) {
        list.innerHTML = '<div style="color: var(--text-muted); font-size: 12px;">Could not load workflows</div>';
    }
}

function renderWorkflowList(workflows) {
    const list = document.getElementById('workflowList');
    list.innerHTML = workflows.map(wf => {
        const safeName = escapeHtml(wf.name);
        return `<div class="workflow-item" onclick="runWorkflow('${safeName}')" title="${escapeHtml(wf.description)}">
            ${safeName}
        </div>`;
    }).join('');
}

function hideWorkflowPicker() {
    document.getElementById('workflowPicker').style.display = 'none';
}

function runWorkflow(name) {
    hideWorkflowPicker();
    // Insert into input field without sending — user can add context
    const input = document.getElementById('messageInput');
    input.value = name + ' ';
    input.focus();
}

// Fetch windows on load and poll for new ones
fetchWindows();
setInterval(fetchWindows, 30000); // Re-discover every 30s



// ===== TAB MANAGEMENT =====
let pinnedTabs = JSON.parse(localStorage.getItem('ag_pinned_tabs') || '[]');
let activeTabTitle = null;

// Clean stale pinned tabs that look like model names (bad data from previous scraping)
{
    const MODEL_RE = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\b/i;
    const before = pinnedTabs.length;
    pinnedTabs = pinnedTabs.filter(t => !MODEL_RE.test(t.title));
    if (pinnedTabs.length !== before) {
        console.log(`🧹 Cleaned ${before - pinnedTabs.length} stale model-name tabs`);
        localStorage.setItem('ag_pinned_tabs', JSON.stringify(pinnedTabs));
    }
}
function saveTabs() {
    localStorage.setItem('ag_pinned_tabs', JSON.stringify(pinnedTabs));
}

function addTab(title) {
    if (!title) return;
    // Don't add model names as tabs
    const MODEL_RE = /^(gemini|claude|gpt|llama|mistral|deepseek|codestral|command|phi|qwen|o[134])\b/i;
    if (MODEL_RE.test(title)) return;
    // Don't add duplicates
    if (pinnedTabs.some(t => t.title === title)) {
        // Just activate it
        activeTabTitle = title;
        renderTabs();
        return;
    }
    pinnedTabs.push({ title });
    activeTabTitle = title;
    saveTabs();
    renderTabs();
}

function togglePinTab(title) {
    const idx = pinnedTabs.findIndex(t => t.title === title);
    if (idx >= 0) {
        pinnedTabs.splice(idx, 1);
        if (activeTabTitle === title) activeTabTitle = null;
    } else {
        addTab(title);
        return; // addTab already saves and renders
    }
    saveTabs();
    renderTabs();
}

function switchTab(title) {
    if (activeTabTitle === title) return; // Already active
    activeTabTitle = title;
    renderTabs();
    selectChat(title);
}

function removeTab(title, event) {
    if (event) { event.stopPropagation(); }
    pinnedTabs = pinnedTabs.filter(t => t.title !== title);
    if (activeTabTitle === title) activeTabTitle = null;
    saveTabs();
    renderTabs();
}

function renderTabs() {
    const tabsBar = document.getElementById('tabsBar');
    if (!pinnedTabs.length) {
        tabsBar.innerHTML = '';
        return;
    }
    tabsBar.innerHTML = pinnedTabs.map(tab => {
        const isActive = tab.title === activeTabTitle;
        const shortTitle = tab.title.length > 20 ? tab.title.substring(0, 18) + '…' : tab.title;
        const safeTitle = escapeHtml(tab.title).replace(/'/g, "\\'");
        return `<div class="tab-chip ${isActive ? 'active' : ''}" onclick="switchTab('${safeTitle}')">
            <span class="tab-label">${escapeHtml(shortTitle)}</span>
            <span class="tab-close" onclick="removeTab('${safeTitle}', event)">✕</span>
        </div>`;
    }).join('');
}

// Auto-detect current conversation and add as tab
async function detectCurrentConversation() {
    try {
        const res = await fetchWithAuth('/current-conversation');
        const data = await res.json();
        if (data.title) {
            // Auto-add the current conversation as a tab and mark active
            addTab(data.title);
        }
    } catch (e) {
        // Silently fail — detection is best-effort
    }
}

// Detect on initial load and periodically
detectCurrentConversation();
setInterval(detectCurrentConversation, 15000); // Check every 15s

// Render tabs on load
renderTabs();

// ===== TERMINAL =====
const terminalLayer = document.getElementById('terminalLayer');
const terminalOutput = document.getElementById('terminalOutput');
const terminalInput = document.getElementById('terminalInput');
const terminalSendBtn = document.getElementById('terminalSendBtn');
const terminalBtn = document.getElementById('terminalBtn');

let termCmdHistory = [];
let termHistoryIdx = -1;

function showTerminal() {
    terminalLayer.classList.add('show');
    setTimeout(() => terminalInput.focus(), 300);
}

function hideTerminal() {
    terminalLayer.classList.remove('show');
}

function clearTerminal() {
    terminalOutput.innerHTML = '<div class="terminal-welcome">Terminal cleared</div>';
}

function appendTerminalOutput(html) {
    terminalOutput.insertAdjacentHTML('beforeend', html);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

async function runTerminalCommand(cmd) {
    if (!cmd.trim()) return;

    // Add to history
    termCmdHistory.push(cmd);
    termHistoryIdx = termCmdHistory.length;

    // Show command in output
    appendTerminalOutput(`<div class="terminal-cmd-line">$ ${escapeHtml(cmd)}</div>`);

    // Disable input while running
    terminalInput.disabled = true;
    terminalSendBtn.disabled = true;

    try {
        const res = await fetchWithAuth('/api/terminal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();

        if (data.stdout) {
            appendTerminalOutput(`<div class="terminal-stdout">${escapeHtml(data.stdout)}</div>`);
        }
        if (data.stderr) {
            appendTerminalOutput(`<div class="terminal-stderr">${escapeHtml(data.stderr)}</div>`);
        }

        const exitClass = data.exitCode !== 0 ? 'error' : '';
        appendTerminalOutput(`<div class="terminal-exit ${exitClass}">exit: ${data.exitCode}${data.signal ? ' (signal: ' + data.signal + ')' : ''}</div>`);

    } catch (e) {
        appendTerminalOutput(`<div class="terminal-stderr">Error: ${escapeHtml(e.message)}</div>`);
    }

    terminalInput.disabled = false;
    terminalSendBtn.disabled = false;
    terminalInput.value = '';
    terminalInput.focus();
}

terminalBtn.addEventListener('click', showTerminal);

terminalSendBtn.addEventListener('click', () => {
    runTerminalCommand(terminalInput.value);
});

terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        runTerminalCommand(terminalInput.value);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (termHistoryIdx > 0) {
            termHistoryIdx--;
            terminalInput.value = termCmdHistory[termHistoryIdx];
        }
    } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (termHistoryIdx < termCmdHistory.length - 1) {
            termHistoryIdx++;
            terminalInput.value = termCmdHistory[termHistoryIdx];
        } else {
            termHistoryIdx = termCmdHistory.length;
            terminalInput.value = '';
        }
    }
});
