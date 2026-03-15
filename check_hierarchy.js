const algoliasearch = require('algoliasearch');
require('dotenv').config();

const client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_WRITE_KEY);
const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME);

async function checkCategories() {
    const categories = new Map();
    const subcategories = new Map();
    const subsubcategories = new Map();

    console.log("Browsing products...");

    try {
        await index.browseObjects({
            attributesToRetrieve: ['category_name', 'subcategory_name', 'subsubcategory_name'],
            batch: batch => {
                batch.forEach(h => {
                    if (h.category_name) categories.set(h.category_name, (categories.get(h.category_name) || 0) + 1);
                    if (h.subcategory_name) subcategories.set(h.subcategory_name, (subcategories.get(h.subcategory_name) || 0) + 1);
                    if (h.subsubcategory_name) subsubcategories.set(h.subsubcategory_name, (subsubcategories.get(h.subsubcategory_name) || 0) + 1);
                });
            }
        });

        console.log("\n--- Categories ---");
        Array.from(categories.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${k} (${v})`));

        console.log("\n--- Subcategories ---");
        Array.from(subcategories.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${k} (${v})`));

        console.log("\n--- Sub-subcategories ---");
        Array.from(subsubcategories.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`${k} (${v})`));

    } catch (err) {
        console.error("Error:", err.message);
    }
}

checkCategories();
