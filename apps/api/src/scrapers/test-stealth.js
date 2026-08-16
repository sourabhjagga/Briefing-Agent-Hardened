const browserManager = require('../browser-manager');

async function test() {
  console.log('🎬 Launching headless browser check...');
  const page = await browserManager.newPage();
  
  console.log('🌐 Navigating to sannysoft bot detector...');
  await page.goto('https://bot.sannysoft.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  
  const title = await page.title();
  console.log('✅ Navigation successful! Page Title: ' + title);
  
  await page.close();
  await browserManager.close();
  console.log('🎉 Browser test completed successfully!');
}

test().catch(err => {
  console.error('❌ Browser test failed: ' + err.message);
  process.exit(1);
});
