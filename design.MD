flowchart TD
    subgraph Step1["Step 1: Extract Filter Metadata"]
        DC_Jira["Jira Data Center"] -->|1. Fetch Filters JSON| DC_Filter_JSON[/"DC Filters List\n(id, name)"/]
        Cloud_Jira["Jira Cloud"] -->|2. Fetch Filters JSON| Cloud_Filter_JSON[/"Cloud Filters List\n(id, name)"/]
    end

    subgraph Step2["Step 2: Map Filters"]
        DC_Filter_JSON --> MapEngine["Match by Filter Name"]
        Cloud_Filter_JSON --> MapEngine
        MapEngine --> FilterMap[/"Filter Mapping Table\n(DC_ID ➔ Cloud_ID)"/]
    end

    subgraph Step3["Step 3: Scan & Transform Content"]
        DC_Conf["Confluence DC"] -->|3. Read Page Content| PageScanner["Scan Content for DC Filter IDs"]
        FilterMap --> PageScanner
        PageScanner -->|Match Found| IDReplacer["Replace DC Filter ID\nwith Cloud Filter ID"]
    end

    subgraph Step4["Step 4: Update Cloud Content"]
        IDReplacer -->|4. Push Updated Content| Cloud_Conf["Confluence Cloud"]
    end

    style Step1 fill:#f9f9f9,stroke:#333,stroke-width:1px
    style Step2 fill:#e1f5fe,stroke:#0288d1,stroke-width:1px
    style Step3 fill:#fff3e0,stroke:#f57c00,stroke-width:1px
    style Step4 fill:#e8f5e9,stroke:#388e3c,stroke-width:1px


sequenceDiagram
    autonumber
    actor Script as Migration Script / Tool
    participant DCJira as Jira DC API
    participant CloudJira as Jira Cloud API
    participant DCConf as Confluence DC API
    participant CloudConf as Confluence Cloud API

    rect rgb(240, 248, 255)
        note over Script, CloudJira: Phase 1: Build Filter ID Mapping Dictionary
        Script->>DCJira: GET /rest/api/2/filter (Fetch all filters)
        DCJira-->>Script: Return DC Filters List [{ id: "10100", name: "Bugs Filter" }]
        
        Script->>CloudJira: GET /rest/api/3/filter (Fetch migrated filters)
        CloudJira-->>Script: Return Cloud Filters List [{ id: "20500", name: "Bugs Filter" }]
        
        Script->>Script: Build Lookup Dictionary:<br/>Map DC Filter ID to Cloud Filter ID by matching 'name'
    end

    rect rgb(255, 250, 240)
        note over Script, CloudConf: Phase 2: Content Scanning & Remapping
        Script->>DCConf: GET /rest/api/content (Fetch Space Pages)
        DCConf-->>Script: Return Confluence DC Page Content (Storage Format)
        
        loop For Each Page
            Script->>Script: Scan Storage Format HTML/ADF for DC Filter IDs
            alt DC Filter ID found in Macro Parameters
                Script->>Script: Replace DC_Filter_ID with Cloud_Filter_ID
                Script->>CloudConf: PUT /rest/api/content/{pageId} (Update Storage Format/ADF)
                CloudConf-->>Script: 200 OK (Page Updated)
            else No Filter ID matched
                Script->>Script: Skip Page
            end
        end
    end