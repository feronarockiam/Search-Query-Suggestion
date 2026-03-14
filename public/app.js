const searchInput = document.getElementById('searchInput');
const dropdown = document.getElementById('dropdown');
const suggestionList = document.getElementById('suggestionList');
const loader = document.getElementById('loader');
const dropdownFooter = document.getElementById('dropdownFooter');

let debounceTimer = null;
let currentFocus = -1;

// Icons mapping depending on suggestion type
const ICONS = {
    brand: `<svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path><line x1="7" y1="7" x2="7.01" y2="7"></line></svg>`,
    ptype: `<svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>`,
    fallback: `<svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>`,
    default: `<svg class="suggestion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`
};

searchInput.addEventListener('input', (e) => {
    const query = e.target.value;

    // Clear debounce
    if (debounceTimer) clearTimeout(debounceTimer);

    if (query.trim().length < 3) {
        closeDropdown();
        loader.style.display = 'none';
        return;
    }

    loader.style.display = 'block';

    // Set trailing-edge debounce
    debounceTimer = setTimeout(() => {
        fetchSuggestions(query);
    }, 150); // 150ms as per Phase 2 Spec
});

// Arrow key navigation
searchInput.addEventListener('keydown', (e) => {
    const items = suggestionList.getElementsByTagName('li');
    if (!dropdown.classList.contains('active')) return;

    if (e.key === 'ArrowDown') {
        currentFocus++;
        addActive(items);
    } else if (e.key === 'ArrowUp') {
        currentFocus--;
        addActive(items);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (currentFocus > -1 && items[currentFocus]) {
            items[currentFocus].click();
        } else if (items.length > 0) {
            items[0].click();
        }
    }
});

async function fetchSuggestions(query) {
    try {
        const response = await fetch(`/api/suggest?q=${encodeURIComponent(query)}`);
        const data = await response.json();
        renderSuggestions(data);
    } catch (err) {
        console.error('Failed to fetch suggestions', err);
        closeDropdown();
    } finally {
        loader.style.display = 'none';
    }
}

function renderSuggestions(data) {
    suggestionList.innerHTML = '';
    currentFocus = -1;

    if (!data.suggestions || data.suggestions.length === 0) {
        closeDropdown();
        return;
    }

    data.suggestions.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'suggestion-item';
        li.dataset.type = item.type;

        // Determine icon
        let icon = ICONS.default;
        if (item.type.includes('brand')) icon = ICONS.brand;
        else if (item.type === 'ptype_only') icon = ICONS.ptype;

        // Subtitle type label
        const typeLabel = item.type.replace('_', ' ');

        const mediaHtml = item.image
            ? `<img src="${item.image}" class="suggestion-thumbnail" alt="${item.text}">`
            : icon;

        li.innerHTML = `
            ${mediaHtml}
            <div class="suggestion-text">${item.highlighted}</div>
            <span class="suggestion-meta">${typeLabel}</span>
        `;

        li.addEventListener('click', () => {
            searchInput.value = item.text;
            closeDropdown();
            // Handle formal search action here
            console.log("Searching for:", item.text);
        });

        suggestionList.appendChild(li);
    });

    // Update Footer
    dropdownFooter.innerHTML = `
        <span>${data.query.length < 3 ? 'Trending' : 'Suggestions'}</span>
        <span>${data.latency_ms}ms</span>
    `;

    openDropdown();
}

function openDropdown() {
    dropdown.classList.add('active');
}

function closeDropdown() {
    dropdown.classList.remove('active');
}

function addActive(items) {
    if (!items) return;
    removeActive(items);
    if (currentFocus >= items.length) currentFocus = 0;
    if (currentFocus < 0) currentFocus = (items.length - 1);
    items[currentFocus].classList.add("selected");

    // Auto-scroll
    items[currentFocus].scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove("selected");
    }
}

// Close when clicking outside
document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== dropdown && !dropdown.contains(e.target)) {
        closeDropdown();
    }
});
