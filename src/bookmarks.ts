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

    function renderBookmarks() {
        const container = document.getElementById('bookmark-list');
        if (!container) return;

        const custom = loadBookmarks();
        const all = [...builtInBookmarks, ...custom];

        container.innerHTML = all.map((bm, i) => `
      <div class="flex items-center gap-1">
        <button
          class="flex-1 text-left text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 truncate"
          data-bm="${i}">${bm.label}
        </button>
        ${i >= builtInBookmarks.length
            ? `<button class="text-red-400 hover:text-red-300 px-1 del-bm" data-bm="${i - builtInBookmarks.length}">×</button>`
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

            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.bm ?? '-1', 10);
                if (idx < 0) return;
                options.onApplyBookmark(all[idx]);
            });
        });
    }

    function saveBookmark() {
        const view = options.getView();
        const label = prompt('Bookmark name:', `Zoom ${Number(view.zoom).toExponential(2)}×`);
        if (!label) return;

        const bookmark: Bookmark = {label, ...view};
        const bookmarks = loadBookmarks();
        bookmarks.push(bookmark);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
        renderBookmarks();
    }

    return {
        renderBookmarks,
        saveBookmark,
    };
}
