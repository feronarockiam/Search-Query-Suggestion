const algoliasearch = require('algoliasearch');
require('dotenv').config();

const client = algoliasearch(process.env.ALGOLIA_APP_ID, process.env.ALGOLIA_WRITE_KEY);
const index = client.initIndex(process.env.ALGOLIA_INDEX_NAME);

async function inspectProducts() {
    console.log("Sampling product records...");

    try {
        const result = await index.search('', { hitsPerPage: 5 });
        console.log(JSON.stringify(result.hits[0], null, 2));
    } catch (err) {
        console.error("Error searching:", err.message);
    }
}

inspectProducts();
