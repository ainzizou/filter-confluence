**Prerequisite:** Before running any migration scripts, you must first fetch the Jira Cloud filters by running:
`npm run get:cloud-filters`
This will save the cloud filters to `cloud_filters.json`, which is essential for the migration process.

You can now run:

- `npm run start:full` to automatically check the whole instance and generate the JSON file.
- `npm run start:specific -- 100001 200002` to run the migration for specific page IDs.
- `npm run start:space -- <SPACE_KEY>` to run the migration for all pages within a specific space.
- `npm start` to run the default script (which runs for 100001 and 200002 automatically based on the fallback in index.js).

### Additional Data Extraction Scripts

You can use the following scripts to extract specific data into JSON files for inspection:

- `npm run get:cloud-filters` - Fetches Jira Cloud filters and saves them to `cloud_filters.json`.
- `npm run get:dc-filters` - Fetches Jira DC filters and saves them to `dc_filters.json`.
- `npm run get:space-pages -- <SPACE_KEY>` - Fetches all pages for a specific Confluence space and saves them to `space_pages_<SPACE_KEY>.json`.

curl -X GET \
  "https://YOUR_JIRA_URL/rest/api/2/myself" \
  -H "Authorization: Bearer YOUR_PAT_TOKEN" \
  -H "Accept: application/json"