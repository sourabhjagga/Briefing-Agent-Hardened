const DealsScraper = require('./deals-scraper');

const mockDb = {
  getCookies: () => null,
  saveCookies: () => null,
  saveMessage: (msg) => {
    console.log('💾 [Mock DB] Saved: ' + msg.messageId + ' | ' + msg.body.replace(/\n/g, ' ').substring(0, 100) + '...');
  }
};

const scraper = new DealsScraper(mockDb, null);

async function run() {
  console.log('🎬 Launching live DesiDime scraping test...');
  await scraper.scrapeDesiDime();
  console.log('🎉 DesiDime scrape test completed!');
}

run().catch(err => {
  console.error('❌ DesiDime test failed: ' + err.message);
  process.exit(1);
});
