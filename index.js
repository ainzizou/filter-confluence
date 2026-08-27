import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import 'dotenv/config';

// Disable TLS verification for self-signed certificates or corporate proxies
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Configuration
const CONFIG = {
  jiraDC: {
    baseUrl: process.env.JIRA_DC_URL,
    token: process.env.JIRA_DC_TOKEN
  },
  jiraCloud: {
    baseUrl: process.env.JIRA_CLOUD_URL,
    email: process.env.JIRA_CLOUD_EMAIL,
    apiToken: process.env.JIRA_CLOUD_TOKEN
  },
  confDC: {
    baseUrl: process.env.CONF_DC_URL,
    token: process.env.CONF_DC_TOKEN
  },
  confCloud: {
    baseUrl: process.env.CONF_CLOUD_URL,
    email: process.env.CONF_CLOUD_EMAIL,
    apiToken: process.env.CONF_CLOUD_TOKEN
  }
};

// Request Headers Helpers
const dcHeaders = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
});

const cloudHeaders = (email, token) => ({
  'Authorization': `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
  'Accept': 'application/json',
  'Content-Type': 'application/json'
});

// Step 1: Extract Filter Metadata
async function extractFilters() {
  console.log('[Step 1] Fetching filter metadata from DC CSV and Cloud...');

  // Fetch DC Filters from CSV
  console.log('Reading DC filters from csv/dc_dev_filters.csv...');
  const csvContent = await fs.readFile('csv/dc_dev_filters.csv', 'utf8');
  const dcFilters = [];
  const lines = csvContent.split('\n');
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Split by comma outside of quotes
    const row = line.split(/,(?=(?:(?:[^\"]*\"){2})*[^\"]*$)/);
    if (row.length >= 2) {
      const id = row[0].replace(/^\"|\"$/g, '').trim();
      const name = row[1].replace(/^\"|\"$/g, '').trim();
      if (id && !isNaN(Number(id))) {
        dcFilters.push({ id, name });
      }
    }
  }

  // Read Cloud Filters from JSON
  console.log('Reading Cloud filters from cloud_filters.json...');
  const cloudContent = await fs.readFile('cloud_filters.json', 'utf8');
  const cloudFilters = JSON.parse(cloudContent);

  return { dcFilters, cloudFilters };
}

// Step 2: Map Filters
function mapFilters(dcFilters, cloudFilters) {
  console.log('[Step 2] Mapping filter IDs by filter name...');
  const filterMap = new Map();

  // Index Cloud filters by normalized name
  const cloudMapByName = new Map(
    cloudFilters.map((f) => [f.name.trim().toLowerCase(), String(f.id)])
  );

  for (const dcFilter of dcFilters) {
    const normalizedName = dcFilter.name.trim().toLowerCase();
    if (cloudMapByName.has(normalizedName)) {
      const cloudId = cloudMapByName.get(normalizedName);
      filterMap.set(String(dcFilter.id), cloudId);
    } else {
      console.warn(`[Warning] No matching Cloud filter for: "${dcFilter.name}" (DC ID: ${dcFilter.id})`);
    }
  }

  return filterMap;
}

// Step 3: Scan & Transform Content
async function scanAndTransform(dcPageId, filterMap) {
  console.log(`[Step 3] Scanning DC page content (ID: ${dcPageId})...`);

  const res = await fetch(`${CONFIG.confDC.baseUrl}/rest/api/content/${dcPageId}?expand=body.storage`, {
    headers: dcHeaders(CONFIG.confDC.token)
  });
  const page = await res.json();
  let content = page.body.storage.value;

  // Replace each DC filter ID with the corresponding Cloud filter ID
  filterMap.forEach((cloudId, dcId) => {
    const regex = new RegExp(`(ac:name=\"jql(?:Query)?\">(filter(?:%3D|=)))${dcId}\\b`, 'g');
    content = content.replace(regex, `$1'${cloudId}'`);
  });

  return { title: page.title, content };
}

// Step 4: Update Cloud Content
async function updateCloudContent(cloudPageId, title, updatedContent) {
  console.log(`[Step 4] Updating Cloud Confluence page (ID: ${cloudPageId})...`);

  // Fetch existing version number
  const currentRes = await fetch(`${CONFIG.confCloud.baseUrl}/rest/api/content/${cloudPageId}`, {
    headers: cloudHeaders(CONFIG.confCloud.email, CONFIG.confCloud.apiToken)
  });
  const currentPage = await currentRes.json();
  const nextVersion = currentPage.version.number + 1;

  // Push update
  const payload = {
    version: { number: nextVersion },
    title: title,
    type: 'page',
    body: {
      storage: {
        value: updatedContent,
        representation: 'storage'
      }
    }
  };

  const updateRes = await fetch(`${CONFIG.confCloud.baseUrl}/rest/api/content/${cloudPageId}`, {
    method: 'PUT',
    headers: cloudHeaders(CONFIG.confCloud.email, CONFIG.confCloud.apiToken),
    body: JSON.stringify(payload)
  });

  if (updateRes.ok) {
    console.log('[Success] Cloud content successfully updated!');
  } else {
    const errorText = await updateRes.text();
    console.error('[Error] Failed to update page:', errorText);
  }
}

// Main Orchestrator for specific page
async function runMigration(dcPageId, cloudPageId) {
  try {
    const { dcFilters, cloudFilters } = await extractFilters();
    const filterMap = mapFilters(dcFilters, cloudFilters);
    const { title, content } = await scanAndTransform(dcPageId, filterMap);
    await updateCloudContent(cloudPageId, title, content);
  } catch (err) {
    console.error('[Migration Error]', err);
  }
}

// Scan whole instance automatically
async function getAllConfluenceSpaces() {
  console.log("Fetching all Confluence DC spaces...");
  const allSpaces = [];
  let nextUrl = `/rest/api/space?limit=100`;

  while (nextUrl) {
    const res = await fetch(`${CONFIG.confDC.baseUrl}${nextUrl}`, {
      headers: dcHeaders(CONFIG.confDC.token),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Confluence DC spaces. Status: ${res.status} ${res.statusText}\nBody: ${await res.text()}`);
    }
    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      break;
    }
    allSpaces.push(...data.results);
    nextUrl = data._links && data._links.next ? data._links.next : null;
  }
  console.log(`Found ${allSpaces.length} spaces in Confluence DC.`);
  return allSpaces;
}

async function autoMigrate() {
  try {
    console.log('--- Starting Auto Migration for Whole Instance ---');
    const { dcFilters, cloudFilters } = await extractFilters();
    const filterMap = mapFilters(dcFilters, cloudFilters);
    
    const spaces = await getAllConfluenceSpaces();
    const foundFilters = [];

    for (const space of spaces) {
      console.log(`Processing space: ${space.name} (Key: ${space.key})...`);
      let nextUrl = `/rest/api/content?type=page&spaceKey=${space.key}&expand=body.storage&limit=50`;

      while (nextUrl) {
      const res = await fetch(`${CONFIG.confDC.baseUrl}${nextUrl}`, {
        headers: dcHeaders(CONFIG.confDC.token)
      });
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        break;
      }

      for (const page of data.results) {
        let content = page.body.storage.value;
        let pageHasFilter = false;
        const matchedFilters = [];

        filterMap.forEach((cloudId, dcId) => {
          const regex = new RegExp(`(ac:name=\"jql(?:Query)?\">(filter(?:%3D|=)))${dcId}\\b`, 'g');
          if (regex.test(content)) {
            pageHasFilter = true;
            matchedFilters.push({ dcId, cloudId });
            content = content.replace(regex, `$1'${cloudId}'`);
          }
        });

        if (pageHasFilter) {
          foundFilters.push({
            pageId: page.id,
            pageTitle: page.title,
            matchedFilters
          });
          
          // Note: In auto-migrate, you'd typically need the corresponding Cloud Page ID 
          // to update it in Cloud, or update it directly in DC if it's an in-place migration.
          // For now, logging the finding as requested.
          console.log(`Found filters in page: ${page.title} (ID: ${page.id})`);
        }
      }

      nextUrl = data._links && data._links.next ? data._links.next : null;
    }
  }

    await fs.writeFile('filter_report.json', JSON.stringify(foundFilters, null, 2));
    console.log('Successfully generated filter_report.json with page IDs and their filters.');
    
  } catch (err) {
    console.error('[Auto Migration Error]', err);
  }
}

async function findCloudPageByTitle(spaceKey, title) {
  const safeTitle = title.replace(/"/g, '\\"');
  const query = encodeURIComponent(`space="${spaceKey}" and title="${safeTitle}"`);
  const res = await fetch(`${CONFIG.confCloud.baseUrl}/rest/api/content/search?cql=${query}`, {
    headers: cloudHeaders(CONFIG.confCloud.email, CONFIG.confCloud.apiToken)
  });
  if (!res.ok) {
    console.error(`[Error] Failed to search Cloud page for title "${title}": HTTP ${res.status} ${res.statusText}`);
    return null;
  }
  const data = await res.json();
  if (data.results && data.results.length > 0) {
    return data.results[0].id;
  }
  return null;
}

async function migrateSpace(spaceKey, applyChanges = false) {
  try {
    console.log(`--- Starting Migration for Space: ${spaceKey} ---`);
    const { dcFilters, cloudFilters } = await extractFilters();
    const filterMap = mapFilters(dcFilters, cloudFilters);
    const foundFilters = [];

    console.log(`Processing space: ${spaceKey}...`);
    let nextUrl = `/rest/api/content?type=page&spaceKey=${spaceKey}&expand=body.storage&limit=50`;

    while (nextUrl) {
      const res = await fetch(`${CONFIG.confDC.baseUrl}${nextUrl}`, {
        headers: dcHeaders(CONFIG.confDC.token),
      });
      const data = await res.json();

      if (!data.results || data.results.length === 0) {
        break;
      }

      for (const page of data.results) {
        let content = page.body.storage.value;
        let pageHasFilter = false;
        const matchedFilters = [];

        filterMap.forEach((cloudId, dcId) => {
          const regex = new RegExp(`(ac:name=\"jql(?:Query)?\">(filter(?:%3D|=)))${dcId}\\b`, 'g');
          if (regex.test(content)) {
            pageHasFilter = true;
            matchedFilters.push({ dcId, cloudId });
            content = content.replace(regex, `$1'${cloudId}'`);
          }
        });

        if (pageHasFilter) {
          foundFilters.push({
            pageId: page.id,
            pageTitle: page.title,
            matchedFilters
          });
          console.log(`Found filters in page: ${page.title} (ID: ${page.id}) in space ${spaceKey}`);
          
          if (applyChanges) {
            const cloudPageId = await findCloudPageByTitle(spaceKey, page.title);
            if (cloudPageId) {
              await updateCloudContent(cloudPageId, page.title, content);
            } else {
              console.warn(`[Warning] Could not find corresponding Cloud page for: ${page.title}`);
            }
          }
        }
      }

      nextUrl = data._links && data._links.next ? data._links.next : null;
    }

    await fs.writeFile(`filter_report_${spaceKey}.json`, JSON.stringify(foundFilters, null, 2));
    console.log(`Successfully generated filter_report_${spaceKey}.json with page IDs and their filters for space ${spaceKey}.`);

  } catch (err) {
    console.error(`[Space Migration Error for ${spaceKey}]`, err);
  }
}

async function getJiraDCFilters() {
  console.log('Fetching Jira DC filters...');
  const allDcFilters = [];
  let startAt = 0;
  let isLast = false;
  const maxResults = 50; // Use a reasonable limit for fetching filters

  while (!isLast) {
    const res = await fetch(`${CONFIG.jiraDC.baseUrl}/rest/api/2/filter/search?maxResults=${maxResults}&startAt=${startAt}&overrideSharePermissions=true`, {
      headers: dcHeaders(CONFIG.jiraDC.token),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch Jira DC filters. Status: ${res.status} ${res.statusText}\nBody: ${await res.text()}`);
    }
    const data = await res.json();

    if (!data.values || data.values.length === 0) {
      break;
    }
    allDcFilters.push(...data.values);
    console.log(`Pagination: Fetched ${data.values.length} DC filters, startAt: ${startAt}, total: ${data.total}`);

    isLast = data.isLast;
    startAt += maxResults;

    if (data.isLast === undefined) break; // Fallback if isLast is not provided
  }

  await fs.writeFile('dc_filters.json', JSON.stringify(allDcFilters, null, 2));
  console.log(`Saved ${allDcFilters.length} Jira DC filters to dc_filters.json`);
  return allDcFilters;
}

// Check arguments to determine mode
const args = process.argv.slice(2);

if (args.includes('--check-access')) {
  (async () => {
    try {
      console.log('--- Checking Connections & Access ---');
      
      // Jira DC
      console.log('\n1. Jira DC...');
      const jDcRes = await fetch(`${CONFIG.jiraDC.baseUrl}/rest/api/2/myself`, { headers: dcHeaders(CONFIG.jiraDC.token) });
      if (jDcRes.ok) {
        const data = await jDcRes.json();
        console.log(`✅ Success! Logged in as: ${data.displayName || data.name}`);
      } else {
        console.log(`❌ Failed: HTTP ${jDcRes.status} ${jDcRes.statusText}\nBody: ${await jDcRes.text()}`);
      }

      // Jira Cloud
      console.log('\n2. Jira Cloud...');
      const jCloudRes = await fetch(`${CONFIG.jiraCloud.baseUrl}/rest/api/3/myself`, { headers: cloudHeaders(CONFIG.jiraCloud.email, CONFIG.jiraCloud.apiToken) });
      if (jCloudRes.ok) {
        const data = await jCloudRes.json();
        console.log(`✅ Success! Logged in as: ${data.displayName || data.emailAddress}`);
      } else {
        console.log(`❌ Failed: HTTP ${jCloudRes.status} ${jCloudRes.statusText}\nBody: ${await jCloudRes.text()}`);
      }

      // Confluence DC
      console.log('\n3. Confluence DC...');
      const cDcRes = await fetch(`${CONFIG.confDC.baseUrl}/rest/api/user/current`, { headers: dcHeaders(CONFIG.confDC.token) });
      if (cDcRes.ok) {
        const data = await cDcRes.json();
        console.log(`✅ Success! Logged in as: ${data.displayName || data.username}`);
      } else {
        console.log(`❌ Failed: HTTP ${cDcRes.status} ${cDcRes.statusText}\nBody: ${await cDcRes.text()}`);
      }

      // Confluence Cloud
      console.log('\n4. Confluence Cloud...');
      const cCloudRes = await fetch(`${CONFIG.confCloud.baseUrl}/rest/api/user/current`, { headers: cloudHeaders(CONFIG.confCloud.email, CONFIG.confCloud.apiToken) });
      if (cCloudRes.ok) {
        const data = await cCloudRes.json();
        console.log(`✅ Success! Logged in as: ${data.publicName || data.displayName || data.email}`);
      } else {
        console.log(`❌ Failed: HTTP ${cCloudRes.status} ${cCloudRes.statusText}\nBody: ${await cCloudRes.text()}`);
      }

    } catch (err) {
      console.error('\nNetwork Error during checks:', err.message);
    }
  })().then(() => process.exit(0));
} else if (args.includes('--get-cloud-filters')) {
  (async () => {
    try {
      console.log('Fetching Cloud filters...');
      const cloudFilters = [];
      let isLast = false;
      let startAt = 0;
      
      while (!isLast) {
        const cloudRes = await fetch(`${CONFIG.jiraCloud.baseUrl}/rest/api/3/filter/search?maxResults=50&startAt=${startAt}&overrideSharePermissions=true`, {
          headers: cloudHeaders(CONFIG.jiraCloud.email, CONFIG.jiraCloud.apiToken)
        });
        if (!cloudRes.ok) {
          throw new Error(`Failed to fetch Cloud filters. Status: ${cloudRes.status} ${cloudRes.statusText}\nBody: ${await cloudRes.text()}`);
        }
        const cloudData = await cloudRes.json();

        console.log(`Pagination: Fetched ${cloudData.values.length} filters, startAt: ${startAt}, total: ${cloudData.total}`);
        
        if (cloudData.values && cloudData.values.length > 0) {
          cloudFilters.push(...cloudData.values);
        }
        
        isLast = cloudData.isLast;
                startAt += 50;
        
        if (cloudData.isLast === undefined) break;
      }

      await fs.writeFile('cloud_filters.json', JSON.stringify(cloudFilters, null, 2));
      console.log(`Saved ${cloudFilters.length} Cloud filters to cloud_filters.json`);
    } catch (err) {
      console.error(err);
    }
  })().then(() => process.exit(0));
} else if (args.includes('--get-dc-filters')) {
  (async () => {
    try {
      await getJiraDCFilters();
    } catch (err) {
      console.error(err);
    }
  })().then(() => process.exit(0));
} else if (args.includes('--get-space-pages')) {
  (async () => {
    try {
      const spaceKeyIndex = args.indexOf('--get-space-pages') + 1;
      const spaceKey = args[spaceKeyIndex];
      if (!spaceKey) {
        console.error('Please provide a space key: --get-space-pages <spaceKey>');
        process.exit(1);
      }
      console.log(`Fetching pages for space: ${spaceKey}...`);
      let nextUrl = `/rest/api/content?type=page&spaceKey=${spaceKey}&expand=body.storage&limit=50`;
      const pages = [];
      while (nextUrl) {
        const res = await fetch(`${CONFIG.confDC.baseUrl}${nextUrl}`, {
          headers: dcHeaders(CONFIG.confDC.token)
        });
        if (!res.ok) {
          throw new Error(`Failed to fetch Space pages. Status: ${res.status} ${res.statusText}\nBody: ${await res.text()}`);
        }
        const data = await res.json();
        if (!data.results || data.results.length === 0) break;
        pages.push(...data.results);
        nextUrl = data._links && data._links.next ? data._links.next : null;
      }
      await fs.writeFile(`space_pages_${spaceKey}.json`, JSON.stringify(pages, null, 2));
      console.log(`Saved ${pages.length} pages to space_pages_${spaceKey}.json`);
    } catch (err) {
      console.error(err);
    }
  })().then(() => process.exit(0));
} else if (args.includes('--space')) {
  const spaceKeyIndex = args.indexOf('--space') + 1;
  let spaceKey = args[spaceKeyIndex];
  if (spaceKey === '--apply') {
    spaceKey = args[spaceKeyIndex + 1];
  }
  const applyChanges = args.includes('--apply');
  if (!spaceKey || spaceKey.startsWith('--')) {
    console.error('Please provide a space key: --space <spaceKey> [--apply]');
    process.exit(1);
  }
  migrateSpace(spaceKey, applyChanges).then(() => process.exit(0));
} else if (args.length === 2) {
  const [dcPageId, cloudPageId] = args;
  runMigration(dcPageId, cloudPageId).then(() => process.exit(0));
} else if (args.includes('--auto')) {
  autoMigrate().then(() => process.exit(0));
} else {
  console.log(`
Usage:
  Run full auto-migration:
    npm run start:full

  Run for specific page pair:
    npm run start:specific -- <dcPageId> <cloudPageId>
    Example: npm run start:specific -- 783880295 478203444

  Run for specific space:
    npm run start:space -- <spaceKey>
    Example: npm run start:space -- MYSPACE

  Get Jira DC filters:
    npm run get:dc-filters

  Check Connections:
    npm run check-access
  `);
  process.exit(1); // Exit with error for invalid command
}
