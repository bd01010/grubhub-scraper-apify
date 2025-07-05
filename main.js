/**
 * Grubhub Menu Scraper - Apify Actor
 * Runs in Apify cloud with residential proxies
 */

import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const {
    restaurantUrl,
    debugMode = false,
    maxRetries = 3,
    proxyConfiguration = { useApifyProxy: true }
} = input;

console.log('Starting Grubhub scraper for:', restaurantUrl);

// Initialize the crawler
const crawler = new PlaywrightCrawler({
    proxyConfiguration: await Actor.createProxyConfiguration({
        groups: ['RESIDENTIAL'],
        countryCode: 'US'
    }),
    
    maxRequestRetries: maxRetries,
    navigationTimeoutSecs: 60,
    
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--disable-blink-features=AutomationControlled']
        }
    },
    
    preNavigationHooks: [
        async ({ page }) => {
            // Stealth mode
            await page.setViewportSize({ width: 1920, height: 1080 });
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
            });
        }
    ],
    
    async requestHandler({ request, page, log }) {
        log.info('Processing:', request.url);
        
        try {
            // Wait for menu to load
            await page.waitForSelector('[data-testid="menu-container"], .menu-content, [class*="menu"]', {
                timeout: 30000
            });
            
            // Wait for dynamic content
            await page.waitForTimeout(3000);
            
            // Extract restaurant info
            const restaurantInfo = await extractRestaurantInfo(page, request.url);
            log.info('Restaurant extracted:', restaurantInfo.name);
            
            // Extract menu categories
            const categories = await extractCategories(page);
            log.info(`Found ${categories.length} categories`);
            
            // Extract all items with modifiers
            const items = [];
            for (const category of categories) {
                const categoryItems = await extractCategoryItems(page, category);
                items.push(...categoryItems);
            }
            
            log.info(`Total items extracted: ${items.length}`);
            
            // Save screenshot if debug mode
            if (debugMode) {
                await page.screenshot({
                    path: 'debug-screenshot.png',
                    fullPage: true
                });
            }
            
            // Store results
            await Actor.pushData({
                restaurantInfo,
                categories,
                items,
                scrapedAt: new Date().toISOString(),
                url: request.url
            });
            
        } catch (error) {
            log.error('Scraping failed:', error);
            throw error;
        }
    }
});

// Run the crawler
await crawler.run([restaurantUrl]);

await Actor.exit();

// Helper functions
async function extractRestaurantInfo(page, url) {
    return await page.evaluate((pageUrl) => {
        const info = {
            url: pageUrl,
            grubhub_id: pageUrl.match(/\/(\d+)$/)?.[1] || null,
            name: document.querySelector('h1')?.textContent?.trim() || 'Unknown',
            rating: null,
            reviewCount: null,
            address: null,
            phone: null,
            deliveryFee: null,
            deliveryTime: null,
            cuisineTypes: []
        };
        
        // Extract rating
        const ratingEl = document.querySelector('[class*="rating"], [aria-label*="rating"]');
        if (ratingEl) {
            const ratingMatch = ratingEl.textContent.match(/([\d.]+)/);
            info.rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
            const reviewMatch = ratingEl.textContent.match(/(\d+)\s*rating/);
            info.reviewCount = reviewMatch ? parseInt(reviewMatch[1]) : null;
        }
        
        // Extract address
        const addressEl = document.querySelector('[class*="address"], a[href*="maps"]');
        if (addressEl) {
            info.address = addressEl.textContent.trim();
        }
        
        // Extract delivery info
        const deliveryElements = document.querySelectorAll('[class*="delivery"], [class*="fee"]');
        deliveryElements.forEach(el => {
            const text = el.textContent;
            if (text.includes('$')) {
                const feeMatch = text.match(/\$?([\d.]+)/);
                if (feeMatch && !info.deliveryFee) {
                    info.deliveryFee = parseFloat(feeMatch[1]);
                }
            }
            if (text.includes('min')) {
                const timeMatch = text.match(/(\d+)[\s-]*(\d+)?\s*min/);
                if (timeMatch && !info.deliveryTime) {
                    info.deliveryTime = timeMatch[2] 
                        ? `${timeMatch[1]}-${timeMatch[2]} min`
                        : `${timeMatch[1]} min`;
                }
            }
        });
        
        // Extract cuisine types
        const cuisineEls = document.querySelectorAll('[class*="cuisine"], [class*="category-tag"]');
        cuisineEls.forEach(el => {
            const cuisine = el.textContent.trim();
            if (cuisine && !info.cuisineTypes.includes(cuisine)) {
                info.cuisineTypes.push(cuisine);
            }
        });
        
        return info;
    }, url);
}

async function extractCategories(page) {
    return await page.evaluate(() => {
        const categories = [];
        const seen = new Set();
        
        // Try multiple selectors
        const selectors = [
            'nav a:not([href="#"])',
            'button[role="tab"]',
            '[class*="category-nav"] a',
            '[class*="menu-section"] h2'
        ];
        
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el, index) => {
                const text = el.textContent?.trim();
                if (text && !seen.has(text) && text.length > 1 && !text.includes('Skip')) {
                    seen.add(text);
                    categories.push({
                        name: text,
                        index: index,
                        selector: selector
                    });
                }
            });
        }
        
        return categories;
    });
}

async function extractCategoryItems(page, category) {
    return await page.evaluate((categoryName) => {
        const items = [];
        
        // Find all potential item containers
        const itemSelectors = [
            '[data-testid*="menu-item"]',
            '[class*="menu-item"]',
            '[class*="MenuItem"]',
            'div[role="button"]:has(h3)',
            'button:has(h3)'
        ];
        
        let itemElements = [];
        for (const selector of itemSelectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
                itemElements = Array.from(elements);
                break;
            }
        }
        
        itemElements.forEach(itemEl => {
            const item = {
                category: categoryName,
                name: null,
                description: null,
                price: null,
                image: null,
                modifiers: []
            };
            
            // Extract name
            const nameEl = itemEl.querySelector('h3, h4, [class*="item-name"]');
            if (nameEl) {
                item.name = nameEl.textContent.trim();
            }
            
            // Extract description
            const descEl = itemEl.querySelector('p, [class*="description"]');
            if (descEl) {
                item.description = descEl.textContent.trim();
            }
            
            // Extract price
            const priceEl = itemEl.querySelector('[class*="price"], span:last-child');
            if (priceEl) {
                const priceMatch = priceEl.textContent.match(/\$?([\d.]+)/);
                if (priceMatch) {
                    item.price = parseFloat(priceMatch[1]);
                }
            }
            
            // Extract image
            const imgEl = itemEl.querySelector('img');
            if (imgEl) {
                item.image = imgEl.src || imgEl.dataset.src;
            }
            
            // Check for modifiers (simplified - full extraction would click on item)
            const hasModifiers = itemEl.textContent.includes('Customize') || 
                               itemEl.querySelector('[class*="customize"]');
            if (hasModifiers) {
                item.hasModifiers = true;
            }
            
            if (item.name && item.price !== null) {
                items.push(item);
            }
        });
        
        return items;
    }, category.name);
}