const algoliasearch = require('algoliasearch');
require('dotenv').config();

const client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_WRITE_KEY);
const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME);

async function checkCategories() {
    const categories = new Map();
    console.log("Browsing products...");

    try {
        await index.browseObjects({
            attributesToRetrieve: ['category_name'],
            batch: batch => {
                batch.forEach(h => {
                    const cat = h.category_name;
                    if (cat) {
                        categories.set(cat, (categories.get(cat) || 0) + 1);
                    }
                });
            }
        });

        console.log("\nUnique Categories Found:");
        const sorted = Array.from(categories.entries()).sort((a, b) => b[1] - a[1]);
        sorted.forEach(([cat, count]) => {
            console.log(`- ${cat} (${count} products)`);
        });
    } catch (err) {
        console.error("Error browsing:", err.message);
    }
}

checkCategories();
