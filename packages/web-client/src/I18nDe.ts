/**
 * German UI text (plan P7 / C3), one table per namespace of
 * defineMessages(). Its own chunk: loaded only when German is active.
 * test/i18n.test.ts checks every table against the English one in code.
 */
export const DE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    common: {
        cancel: 'Abbrechen',
        close: 'Schließen',
        save: 'Speichern',
        delete: 'Löschen',
        edit: 'Bearbeiten',
        open: 'Öffnen',
        add: 'Hinzufügen',
        create: 'Anlegen',
        remove: 'Entfernen',
        rename: 'Umbenennen',
        retry: 'Erneut versuchen',
        refresh: 'Aktualisieren',
        loading: 'Lädt…',
        ok: 'OK',
        yes: 'Ja',
        no: 'Nein',
        none: 'keine',
        copied: 'Kopiert'
    },
    activityLog: {
        read: 'gelesen',
        write: 'geschrieben',
        delete: 'gelöscht',
        search: 'gesucht',
        list: 'gelistet',
        graph: 'Graph',
        tags: 'Tags',
        now: 'jetzt',
        close: 'Aktivitätslog schließen',
        title: 'MCP-Aktivität'
    },
    app: {
        excerpt: 'Auszug aus {note}',
        noteNotFound: 'Keine Notiz gefunden für „{ref}“. Verlinke die Notiz mit ihrem exakten Titel, einem Alias oder ihrem Pfad (z. B. Memory/projekt/notiz.md).'
    },
    appCommands: {
        goTo: 'Gehe zu {tab}',
        newNote: 'Neue Notiz',
        search: 'Notizen suchen (Volltext / semantisch)',
        import: 'ChatGPT-Export importieren',
        toDark: 'Zum dunklen Theme wechseln',
        toLight: 'Zum hellen Theme wechseln',
        activity: 'Aktivitätslog ein-/ausblenden',
        to2d: 'Graph: zu 2D wechseln',
        to3d: 'Graph: zu 3D wechseln',
        roadmapProject: 'Roadmap: neues Projekt',
        roadmapStep: 'Roadmap: neuer Schritt',
        shortcuts: 'Tastenkürzel',
        copyLink: 'Link zu dieser Ansicht kopieren',
        linkCopied: 'Link kopiert',
        settings: 'Kontoeinstellungen',
        language: 'Sprache: zu {name} wechseln'
    },
    commandPalette: {
        placeholder: 'Befehl eingeben oder Notizen suchen… (Esc schließt)',
        label: 'Befehlspalette',
        results: 'Ergebnisse',
        noMatches: 'Keine Treffer',
        via: 'über {field}'
    },
    consentInbox: {
        title: 'Freigaben',
        hint: 'Claude möchte diese Notizen über MCP lesen. Gib jede Anfrage frei oder lehne sie ab. '
            + 'Die Entscheidung landet im Frontmatter der Notiz (mcp_consent), spätere Lesezugriffe laufen dann ohne erneute Nachfrage durch.',
        empty: 'Keine offenen Anfragen. Wenn Claude eine Notiz mit „mcp_consent: pending“ im Frontmatter lesen will, erscheint sie hier.',
        openNote: 'Notiz im Notizbereich öffnen',
        requester: 'angefragt von: {name}',
        approve: 'Freigeben',
        deny: 'Ablehnen'
    },
    dialogs: {
        invalidProject: 'Ungültiger Projektname: nur a-z, 0-9, . _ -'
    },
    graph: {
        fetching: 'Graph wird geladen…',
        fetched: '{nodes} Knoten / {edges} Kanten in {ms} ms geladen',
        computing: 'Layout für {nodes} Knoten / {edges} Kanten wird berechnet…',
        layoutFailed: 'Layout fehlgeschlagen: {cause}',
        nodes: '{count} Knoten|{count} Knoten',
        edges: '{count} Kante|{count} Kanten',
        communities: '{count} Community|{count} Communities',
        overview: 'Übersicht · {count} Communities',
        modularity: 'Mod {value}',
        zoomClick: 'Zoom {zoom}× (Community anklicken)',
        zoom: 'Zoom {zoom}×',
        layoutMs: 'Layout {ms} ms',
        updating: 'wird aktualisiert…'
    },
    login: {
        hostSignIn: 'Melde dich in der Host-Anwendung an, um Synaipse zu nutzen.',
        noAccount: 'Kein Synaipse-Konto für {user}. Bitte einen Synaipse-Admin, eines mit dieser E-Mail anzulegen.',
        subtitle: 'Zum Fortfahren anmelden',
        email: 'E-Mail',
        password: 'Passwort',
        signIn: 'Anmelden',
        required: 'E-Mail und Passwort sind erforderlich',
        signingIn: 'Anmeldung läuft…'
    },
    search: {
        placeholder: 'Suchen…  (/)',
        label: 'Notizen durchsuchen',
        fulltext: 'Volltext',
        semantic: 'semantisch',
        hybrid: 'hybrid',
        searching: 'sucht…',
        error: 'Fehler: {message}',
        noResults: 'keine Treffer',
        breakdown: 'Klick zeigt die Aufschlüsselung der Signale',
        rank: 'Rang {rank}',
        demoteWhy: '— Crawler-Index / viele Wikilinks'
    },
    settings: {
        signOut: 'Abmelden',
        hostManaged: 'Über die Host-Anwendung angemeldet; dort abmelden.',
        staySignedIn: 'Du bleibst über Browser-Sitzungen hinweg angemeldet, bis du dich abmeldest.',
        title: 'Kontoeinstellungen',
        sections: 'Bereiche der Einstellungen',
        myTokens: 'Meine Tokens',
        admin: 'Admin'
    },
    shortcuts: {
        title: 'Tastenkürzel',
        everywhere: 'Überall',
        palette: 'Befehlspalette: Befehle, Tabs, Notizen',
        search: 'Suchfeld fokussieren',
        overview: 'Diese Übersicht',
        escape: 'Dialog, Palette oder Menü schließen',
        back: 'Zurück zur vorigen Ansicht (Browser-Verlauf)',
        dialogs: 'Dialoge',
        nextField: 'Nächstes Feld (bleibt im Dialog)',
        confirm: 'Bestätigen (DSGVO-Marker, Grundriss)',
        editor: 'Notiz-Editor',
        bold: 'Fett',
        italic: 'Kursiv',
        code: 'Inline-Code',
        link: 'Link einfügen (im Editor)',
        gdpr: 'Auswahl als DSGVO-relevant markieren'
    },
    tabs: {
        notes: 'Notizen',
        graph: 'Graph',
        canvas: 'Canvas',
        inbox: 'Inbox',
        inboxTitle: 'remember-Einträge der Agenten: in Notizen übernehmen oder verwerfen',
        roadmap: 'Roadmap',
        roadmapTitle: 'Roadmap pro Projekt — KI-geplante Umsetzungsschritte',
        benchmarks: 'Benchmarks',
        benchmarksTitle: 'Benchmarks pro Projekt — Speed- und Qualitätsvergleiche nach Maschine, Backend, Technik',
        chat: 'Chat',
        jobs: 'Jobs',
        activity: 'Aktivität',
        audit: 'Audit',
        auditTitle: 'DSGVO Layer 4 — Audit-Log externer LLM-Aufrufe',
        consent: 'Freigaben',
        consentTitle: 'Freigabe-Anfragen, wenn MCP-Clients Notizen lesen wollen'
    },
    tagBar: {
        viewOptions: 'Ansichtsoptionen',
        view: 'Ansicht',
        heat: 'Aktivität',
        hulls: 'Hüllen',
        room: 'Raum',
        cluster: 'Cluster',
        communities: 'Communities',
        filter: 'Filter',
        isolated: 'isolierte',
        viewMode: 'Darstellung',
        tooMany3d: 'Der Graph hat {nodes} Knoten – zu viele für 3D, es wird 2D gezeigt.',
        slow3d: 'Der Graph hat {nodes} Knoten – 3D wird langsam, 2D empfohlen.',
        note3dOff: '{nodes} Knoten · 3D aus',
        note2dRecommended: '{nodes} Knoten · 2D empfohlen',
        noProjectTitle: 'Kein Projekt gewählt – der ganze Vault ist sichtbar',
        allProjects: 'alle Projekte',
        pinnedTo: 'Auf Projekt {name} festgelegt',
        tagsSelected: 'Tags · {selected}/{total}',
        tags: 'Tags · {total}',
        clearTitle: 'Tag-Filter leeren',
        clear: 'leeren',
        removeFromFilter: 'Aus dem Filter nehmen'
    },
    tagPicker: {
        selectTags: 'Tags auswählen',
        filterPlaceholder: 'Tags filtern…',
        filterLabel: 'Tags filtern',
        clear: 'leeren ({count})',
        noMatch: 'keine passenden Tags',
        other: 'sonstige'
    },
    topbar: {
        activityTitle: 'Aktivitätslog',
        activityToggle: 'Aktivitätslog ein-/ausblenden',
        activity: 'Aktivität',
        paletteTitle: 'Befehlspalette öffnen (Strg/Cmd+K)',
        search: 'Suche',
        importTitle: 'Notizen aus einer externen Quelle importieren',
        import: 'Import',
        accountTitle: 'Angemeldet als {email} — Kontoeinstellungen öffnen',
        toDark: 'Zum dunklen Theme wechseln',
        toLight: 'Zum hellen Theme wechseln',
        language: 'Sprache: {name} — zu {other} wechseln'
    }
};
