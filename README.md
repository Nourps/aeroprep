# AeroPrep

Outil web auto-hébergé pour pilotes : **révision ATPL EASA**, **espace A320 séparé** (questions systèmes, bibliothèque de PDF, assistant IA qui répond à partir des documents) et **agrégateur d'offres d'emploi pilote** avec filtres. Comptes email / mot de passe avec rôles, interface **français / anglais**.

## Fonctionnalités

### Révision ATPL (13 matières EASA)
010 Réglementation · 021 Cellule/systèmes/moteurs · 022 Instrumentation · 031 Masse & centrage · 032 Performances · 033 Préparation du vol · 040 Performances humaines · 050 Météo · 061 Navigation générale · 062 Radionavigation · 070 Procédures opérationnelles · 081 Mécanique du vol · 090 Communications.

- **Entraînement** : correction + explication + référence après chaque question (raccourcis clavier 1-4 / A-D, Entrée).
- **Examen blanc** : chronométré (75 s/question par défaut), navigation libre, correction à la fin, seuil 75 %.
- **Répétition espacée** (boîtes de Leitner) : une question ratée revient le jour même, puis 1, 3, 7, 16, 35 jours.
- Sélections : jamais vues d'abord, ratées récemment, à revoir, marquées.
- **Statistiques** par matière : activité sur 30 jours, boîtes de répétition, historique des examens, points faibles par thème.
- Signalement d'une question (« Marquer » + note) visible par l'admin.

La banque de départ contient **≈ 210 questions originales** (≈ 150 ATPL, ≈ 60 A320), rédigées en anglais (langue de l'examen) et calées sur le syllabus EASA / la logique FCOM. Les banques commerciales (PASS, Aviationexam, Bristol…) sont protégées et ne sont pas reprises. L'admin peut ajouter, corriger, importer/exporter des questions en JSON, et **générer des questions A320 depuis un PDF avec l'IA** (elles arrivent désactivées, à relire avant activation).

### Espace A320 (séparé de l'ATPL)
- **Systèmes** : questions par chapitre ATA (hydraulique, électrique, pneumatique, carburant, commandes de vol et lois, FMGS/AP/A-THR, ECAM, train, feu, APU, moteurs, procédures…), avec leurs propres statistiques.
- **Documents** : bibliothèque de PDF classés (FCOM, FCTM, QRH, MEL, bulletins, SOP, notes de QT), consultables dans le navigateur, recherche plein texte avec extraits. Réservée aux comptes validés.
- **Assistant IA** : pose une question en français ou en anglais ; l'IA cherche elle-même dans les PDF indexés (outils de recherche et de lecture de page), répond en citant les pages, et chaque citation est un lien qui ouvre le PDF à la bonne page.

### Offres d'emploi
- Agrégation automatique depuis des **sources configurées par l'admin** : flux RSS/Atom, API publiques **Greenhouse** et **Lever**, pages carrières balisées `JobPosting` (schema.org, faites pour les moteurs de recherche ; `robots.txt` respecté).
- **« Ajouter une offre »** pour tout le reste (LinkedIn, sites qui interdisent la collecte automatique) : on colle le lien, l'outil lit la page quand c'est autorisé, sinon on remplit le formulaire. LinkedIn n'est jamais lu automatiquement.
- **Classement automatique** (corrigeable à la main) : catégorie (cadet / ab initio, qualifié sans QT, FO qualifié sur type, commandant, instructeur), QT requise ou non, avion (A320 family, A220, B737, B777/787, A330/350, ATR, Dash 8, Embraer, aviation d'affaires…), heures minimum.
- **Filtres** : catégorie, QT, avion, *mes heures de vol* (n'affiche que les offres accessibles), date de publication, recherche texte, tri. Suivi personnel : sauvegardée / postulé / masquée.

### Comptes, rôles et quotas IA
| Rôle | Révision | Offres (voir) | Ajouter une offre | Documents A320 | IA | Admin |
|---|---|---|---|---|---|---|
| En attente (nouvel inscrit) | ✓ | ✓ | – | – | quota (0 par défaut) | – |
| Lecture seule | ✓ | ✓ | – | ✓ | quota (5/jour) | – |
| Membre | ✓ | ✓ | ✓ | ✓ | quota (20/jour) | – |
| Admin | ✓ | ✓ | ✓ | ✓ + ajout/suppression | illimité (-1) | ✓ |

- Le **premier compte créé devient admin** (ou les emails listés dans `ADMIN_EMAILS`). Les suivants arrivent « en attente » jusqu'à validation dans *Admin › Utilisateurs*.
- Quotas IA **par rôle** réglables dans *Admin › Réglages*, et **par utilisateur** (surcharge) dans *Admin › Utilisateurs*.
- *Admin › Consommation IA* : questions et tokens par utilisateur sur 30 jours, coût estimé, derniers appels.
- Pas de serveur mail : en cas d'oubli, l'admin génère un mot de passe temporaire.

## Installation

### Windows : installation en un double-clic
1. Dézippe le dossier (par exemple dans *Documents*).
2. Double-clique sur **`INSTALLER-AEROPREP.bat`**. Le script installe Node.js s'il manque (via winget), télécharge les composants, crée la configuration et un raccourci **AeroPrep** sur le bureau, puis ouvre le site.
3. Ensuite, pour lancer AeroPrep : raccourci du bureau ou **`LANCER-AEROPREP.bat`** (garder la fenêtre ouverte). Adresse : http://localhost:3000.

Le détail (message SmartScreen, pare-feu, réseau local) est dans `COMMENT-INSTALLER.txt`.

### Serveur (Linux / Docker) avec accès depuis Internet
Prérequis : **Node.js 22.13+** (ou Docker), une machine qui reste allumée, un nom DuckDNS pointant vers ta box, et les ports 80/443 redirigés vers la machine.

### Option A — Docker + HTTPS automatique (recommandé)
```bash
git clone <ce dépôt> aeroprep && cd aeroprep
cp .env.example .env          # mettre DOMAIN=tonnom.duckdns.org
mkdir -p data && sudo chown 1000:1000 data   # le conteneur tourne en utilisateur non-root
docker compose up -d --build
```
Caddy obtient et renouvelle le certificat Let's Encrypt tout seul. Ouvre `https://tonnom.duckdns.org`, crée ton compte : il sera admin.

### Option B — Node directement
```bash
npm ci --omit=dev
cp .env.example .env
npm start                     # http://localhost:3000
```
Pour l'exposer sur Internet, place un reverse proxy HTTPS devant (Caddy, nginx…), mets `SECURE_COOKIES=true` et `TRUST_PROXY=1`. Un exemple de service systemd est dans `deploy/aeroprep.service`.

### Clé API (assistant IA)
Deux possibilités, au choix :
1. *Admin › Réglages › Clé API Anthropic* (stockée dans la base du serveur, jamais renvoyée au navigateur) ;
2. variable `ANTHROPIC_API_KEY` dans `.env` (prioritaire).

Modèle par défaut : `claude-opus-5-5`, effort de raisonnement `medium` — tous deux modifiables dans les réglages (ex. `claude-sonnet-5-5` ou `claude-haiku-4-5` pour réduire le coût). Une question à l'assistant fait en général 2 à 4 appels (recherches puis réponse), comptés comme **une** question dans le quota.

### Premiers pas après l'installation
1. *A320 › Documents* : ajoute tes PDF (FCOM, FCTM, QRH…). L'indexation se fait en arrière-plan ; un PDF scanné sans couche texte est signalé « aucun texte » (il faut alors l'OCRiser avant envoi).
2. *Admin › Sources d'offres* : ajoute les sources ouvertes de ton choix, puis « Tout rafraîchir ». Le rafraîchissement automatique a lieu toutes les 6 h (réglable).
3. *Admin › Utilisateurs* : valide les comptes de tes amis (rôle Membre ou Lecture seule).

### Sauvegarde
Tout est dans le dossier `data/` : `aeroprep.db` (comptes, questions, progression, offres) et `documents/` (PDF). Sauvegarder ce dossier suffit (de préférence application arrêtée, ou avec `sqlite3 data/aeroprep.db ".backup save.db"`).

## Ajouter des questions

- **Une par une, depuis le site** : bouton **« + Ajouter une question »** sur la page ATPL ou *A320 › Systèmes* (ou *Admin › Banque de questions*). Matière, question, réponses A à D (on coche la bonne), explication. Le bouton **« Enregistrer et en ajouter une autre »** garde la matière et le thème pour enchaîner une série.
- **En masse avec Excel** : *Admin › Banque de questions › Modèle Excel/CSV*. Une ligne par question, colonnes :

  | matiere | theme | question | A | B | C | D | bonne_reponse | explication | difficulte | reference |
  |---|---|---|---|---|---|---|---|---|---|---|
  | 050 | Fronts | Au passage d'un front froid… | Recule | Vire | … | … | B | Le vent vire… | 2 | Météo |

  Enregistre en « CSV UTF-8 » ou « CSV (séparateur : point-virgule) » puis **« Importer (Excel/CSV) »**. Les lignes refusées sont listées avec leur numéro et la raison. `bonne_reponse` = A, B, C, D (ou 1 à 4) ; `difficulte` = 1, 2 ou 3 ; les colonnes E et F sont possibles pour plus de 4 réponses ; `050` écrit `50` par Excel est accepté.
- **Propositions des membres** : les membres validés ont aussi le bouton « + Ajouter une question » ; leurs questions arrivent désactivées et attendent ta validation (filtre « À relire (inactives) »).
- **Depuis un PDF avec l'IA** : *Admin › Banque de questions › Générer des questions depuis un document*.

### Format JSON (import/export)
```json
[
  {
    "subject": "A29",
    "topic": "PTU",
    "question": "When does the PTU operate automatically?",
    "options": ["…", "…", "…", "…"],
    "correct": 1,
    "explanation": "…",
    "difficulty": 2,
    "reference": "FCOM DSC-29"
  }
]
```
`subject` : code de matière (`010` … `090` pour l'ATPL, `A20` … `A99` pour l'A320, voir `server/db.js`). `correct` est l'index (0 = première réponse). Les réponses sont mélangées à l'affichage. Tes flashcards d'entretien OPL peuvent être importées dans ce format ou via le modèle Excel.

## Développement
```bash
npm install
npm run dev      # redémarre à chaque modification
npm test         # tests API + classement des offres
npm run check    # vérifie les fichiers seed/*.json
```
Structure : `server/` (Express 5, SQLite intégré à Node.js (`node:sqlite`, aucun module à compiler), FTS5 pour la recherche, pdf.js pour l'extraction de texte, SDK Anthropic), `public/` (interface en JavaScript natif, sans build), `seed/` (banques de questions).

## Points d'attention
- **Documents** : FCOM/QRH appartiennent à Airbus ou à la compagnie et sont souvent confidentiels. La bibliothèque n'est accessible qu'aux comptes validés ; ne valide que des personnes de confiance. La documentation approuvée et à jour de la compagnie fait toujours foi.
- **Questions** : rédigées avec soin mais sans valeur officielle ; les valeurs A320 correspondent à l'A320ceo et peuvent différer selon la version (neo, A319/A321, options compagnie). Utilise « Marquer » pour signaler une erreur.
- **Offres d'emploi** : n'ajoute comme source automatique que des sites qui l'autorisent ; pour le reste, l'ajout manuel est prévu.
