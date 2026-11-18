# Presentor Manager

Logiciel de diffusion pour événements : il gère sur grand écran les présentations PowerPoint, vidéos, images, visioconférences, sondages et questions du public. Il pilote plusieurs sorties vidéo et ne coupe pas l'image entre deux médias.

Il fonctionne de trois façons, à partir du même code :

| Mode | Usage |
|---|---|
| **App Mac / PC** (Electron) | Régie sur l'ordinateur de diffusion. Chaque sortie s'ouvre en plein écran sur l'écran physique choisi. |
| **Réseau local** | Les autres appareils du réseau (téléphones, PC d'écrans déportés) se connectent à la régie. |
| **En ligne** | Serveur hébergé (Docker). Le public vote depuis Internet. Accès régie protégé par code PIN. |

## Fonctions

- **Conducteur** : liste ordonnée des éléments (glisser-déposer pour réordonner), avec un écran *preview* et un écran *programme*, un bouton **TAKE**, et une transition fondu ou cut.
- **Sans coupure** : chaque contenu est préparé en arrière-plan et ne s'affiche qu'une fois prêt. La diapositive suivante est préchargée. Si le réseau coupe, l'écran garde la dernière image.
- **PowerPoint / Keynote / PDF** : la conversion se fait automatiquement (LibreOffice). Les **notes du présentateur** sont extraites du .pptx.
- **Télécommandes de présentation** (Logitech, Kensington…) : elles fonctionnent sur la régie comme sur n'importe quelle sortie (PageUp/PageDown, flèches, B pour l'écran noir). Dans l'app, une option permet de les capter même quand la régie n'a pas le focus.
- **Télécommande smartphone** (`/remote/`) : suivant / précédent, notes, chrono, écran noir.
- **Sorties multiples** : chaque sortie affiche au choix :
  - le *Programme* ;
  - le *Programme sans habillage* ;
  - la *Preview* ;
  - le *Retour présentateur* (diapo en cours, diapo suivante, notes, chrono, messages de la régie) ;
  - le *Multiview régie* ;
  - un élément fixe (logo ou boucle vidéo pour les écrans périphériques).
- **Vidéo** : lecture synchronisée sur toutes les sorties (horloge commune). Lecture en boucle, enchaînement automatique, volume, choix de la sortie qui porte le son.
- **Visio** :
  - page web intégrée (Zoom, Teams, Meet, Jitsi…). L'app desktop lève le blocage d'intégration imposé par certains sites ;
  - ou, solution recommandée en pro, le PC de visio passé par une **carte d'acquisition HDMI** (élément « Caméra / capture »).
- **Sondages en direct** : choix unique, choix multiples, note sur 5, nuage de mots. Le QR code s'affiche à l'écran et les résultats se mettent à jour en temps réel.
- **Questions du public** : modération (valider, rejeter) puis affichage à l'écran.
- **Direct** :
  - message au présentateur ;
  - bandeau nom / fonction (lower-third) ;
  - compte à rebours ;
  - écran noir et logo.

## Démarrer

```bash
npm install
```

App desktop :

```bash
npm run desktop
```

Mode serveur (réseau local ou en ligne) :

```bash
npm start
```

Ouvrez ensuite `http://localhost:4517/control/` pour la régie. Sur chaque ordinateur relié à un écran, ouvrez `http://<ip>:4517/output/` puis choisissez la sortie.

**Protéger la régie en ligne :**

```bash
PRESENTOR_PIN=1234 npm start
```

Pour la conversion PowerPoint, installez [LibreOffice](https://www.libreoffice.org/). Sans LibreOffice, importez vos présentations au format PDF.

### Installeurs Mac / Windows

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

Les installeurs sont produits dans `dist/`. Le `.dmg` doit être construit sur un Mac. Le `.exe` se construit de préférence sur Windows.

### En ligne avec Docker

```bash
docker build -t presentor .
```

```bash
docker run -p 4517:4517 -v presentor-data:/data -e PRESENTOR_PIN=1234 presentor
```

Placez un reverse-proxy HTTPS devant (WebSocket sur `/ws`). Renseignez l'URL publique dans *Réglages* : le QR code de vote pointera dessus.

## Raccourcis régie

| Touche | Action |
|---|---|
| Entrée / Espace | TAKE (preview → programme) |
| → / PageDown | Suivant |
| ← / PageUp | Précédent |
| B | Écran noir |
| L | Logo |
| Échap | Vider le programme |

## Architecture

```
server/        Serveur Node (Express + WebSocket) : état du show, médias, conversion
  store.js     Logique de régie (conducteur, navigation, lecture, sondages, Q&R)
  media.js     Import, conversion PowerPoint→PDF, extraction des notes
public/
  shared/      Moteur de rendu sans coupure + client temps réel
  control/     Régie
  output/      Sorties (programme, présentateur, multiview…)
  remote/      Télécommande smartphone
  vote/        Page publique (votes, questions)
electron/      App Mac/PC : serveur embarqué, sorties plein écran par écran physique
test/          Tests de la logique de régie (npm test)
```
