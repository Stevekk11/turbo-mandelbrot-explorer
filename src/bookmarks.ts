import type {Bookmark, ViewState} from './types';

const STORAGE_KEY = 'mandelbrot-bookmarks';

export function createBookmarks(options: {
    getView: () => ViewState;
    onApplyBookmark: (bookmark: Bookmark) => void;
    builtInBookmarks?: Bookmark[];
}) {
    const builtInBookmarks = options.builtInBookmarks ?? [];

    function loadBookmarks(): Bookmark[] {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) return JSON.parse(stored) as Bookmark[];
        } catch {
            // Ignore malformed local storage data and fall back to an empty list.
        }
        return [];
    }

    function escapeHtml(unsafe: string) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function renderBookmarks() {
        const container = document.getElementById('bookmark-list');
        if (!container) return;

        const custom = loadBookmarks();
        const all = [...builtInBookmarks, ...custom];

        container.innerHTML = all.map((bm, i) => `
      <div class="flex items-center gap-1">
        <button
          class="flex-1 text-left text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 truncate"
          data-bm="${i}">${escapeHtml(bm.label)}
        </button>
        ${i >= builtInBookmarks.length
            ? `<button class="text-blue-400 hover:text-blue-300 px-1 ren-bm" data-bm="${i - builtInBookmarks.length}" title="Rename">✎</button>
               <button class="text-red-400 hover:text-red-300 px-1 del-bm" data-bm="${i - builtInBookmarks.length}" title="Delete">×</button>`
            : ''}
      </div>
    `).join('');

        container.querySelectorAll<HTMLButtonElement>('button[data-bm]').forEach((btn) => {
            if (btn.classList.contains('del-bm')) {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.bm ?? '-1', 10);
                    if (idx < 0) return;
                    const bookmarks = loadBookmarks();
                    bookmarks.splice(idx, 1);
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
                    renderBookmarks();
                });
                return;
            }

            if (btn.classList.contains('ren-bm')) {
                btn.addEventListener('click', () => {
                    const idx = parseInt(btn.dataset.bm ?? '-1', 10);
                    if (idx < 0) return;
                    const bookmarks = loadBookmarks();
                    const newLabel = prompt('Rename bookmark:', bookmarks[idx].label);
                    if (newLabel && newLabel.trim() !== '') {
                        bookmarks[idx].label = newLabel.trim();
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
                        renderBookmarks();
                    }
                });
                return;
            }

            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.bm ?? '-1', 10);
                if (idx < 0) return;
                options.onApplyBookmark(all[idx]);
            });
        });
    }

    function saveBookmark() {
        const view = options.getView();
        
        let zStr: string;
        const z = Number(view.zoom);
        if (z < 1000) zStr = `${z.toFixed(1)}×`;
        else if (z < 1e6) zStr = `${(z / 1000).toFixed(2)}K×`;
        else if (z < 1e9) zStr = `${(z / 1e6).toFixed(2)}M×`;
        else if (z < 1e12) zStr = `${(z / 1e9).toFixed(2)}G×`;
        else zStr = `${z.toExponential(2)}×`;

        const bookmarks = loadBookmarks();

        let defaultLabel = `Zoom ${zStr}`;
        let suffix = 1;
        while (bookmarks.some(b => b.label === defaultLabel) || builtInBookmarks.some(b => b.label === defaultLabel)) {
            suffix++;
            defaultLabel = `Zoom ${zStr} (${suffix})`;
        }

        const label = prompt('Bookmark name:', defaultLabel);
        if (!label) return;

        const bookmark: Bookmark = {...view, label};
        bookmarks.push(bookmark);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
        renderBookmarks();
    }

    return {
        renderBookmarks,
        saveBookmark,
    };
}
