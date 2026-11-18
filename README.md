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
- **PowerPoint / Keynote / PDF**, deux rendus au choix pour chaque présentation :
  - **Images + vidéos intégrées** (fonctionne partout, y compris en ligne) : conversion automatique (LibreOffice). Les vidéos et sons insérés dans le .pptx sont extraits et rejoués à leur position exacte, au volume défini dans PowerPoint. Les animations ne sont pas conservées.
  - **PowerPoint natif** (app Mac/PC où PowerPoint est installé) : l'app pilote PowerPoint et capture la fenêtre du diaporama. Animations, transitions, builds et vidéos sont rendus par PowerPoint lui-même, et la télécommande les déclenche une à une. À la fin du diaporama, la régie enchaîne sur l'élément suivant.
  - Les **notes du présentateur** sont extraites du .pptx dans les deux cas.
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
- **Scènes et calques** : on compose une image avec plusieurs sources (présentation, vidéo, caméra, NDI, page web…), chacune placée à la position et à la taille voulues. Réglages par calque : opacité, recadrage, ajustement, arrondi. L'éditeur visuel fonctionne à la souris, avec aimantation et préréglages (côte à côte, incrustation, diapo + intervenant, grille). Le calque principal suit suivant / précédent. Une scène à fond transparent peut servir d'**habillage** par-dessus le programme (logo, cadre, caméra en incrustation).
- **Mapping vidéo** : chaque sortie peut contenir plusieurs zones de projection, avec :
  - déformation sur 4 coins (trapèze, écran incliné, décor) ;
  - partie de la source affichée ;
  - **fondu de bord** corrigé en gamma pour raccorder plusieurs projecteurs ;
  - mire de calage.

  L'éditeur affiche la vraie sortie et le projecteur suit en direct.
- **NDI** (app Mac/PC) :
  - **entrée** : élément « Source NDI » (image et son), découverte automatique ou par adresse IP ;
  - **sortie** : chaque sortie peut être publiée en NDI, qu'elle soit affichée sur un écran ou purement virtuelle (rendu hors écran 1920×1080).
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

### Prérequis selon les fonctions

| Fonction | Prérequis |
|---|---|
| Conversion PowerPoint en images | LibreOffice installé (sinon importer en PDF) |
| PowerPoint natif (animations) | App Mac/PC + Microsoft PowerPoint installé sur la même machine. Mac : autoriser l'app dans *Confidentialité → Automatisation* et *Enregistrement de l'écran* |
| NDI | App Mac/PC. Le module NDI est compilé à l'installation (`npm install`) : Xcode Command Line Tools sur Mac, « Build Tools for Visual Studio » sur Windows |

Sans PowerPoint ou hors de l'app desktop, une présentation réglée en « natif » retombe automatiquement sur le rendu images.

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
  store.js     Logique de régie (conducteur, scènes, navigation, lecture, sondages, Q&R)
  media.js     Import, conversion PowerPoint→PDF, extraction des notes et des vidéos
  ndi.js       Découverte des sources NDI
public/
  shared/      Moteur de rendu sans coupure, scènes, mapping + client temps réel
  control/     Régie
  output/      Sorties (programme, présentateur, multiview…)
  remote/      Télécommande smartphone
  vote/        Page publique (votes, questions)
electron/      App Mac/PC : serveur embarqué, sorties plein écran par écran physique,
               réception NDI (preload), publication NDI (ndi-out), pilote PowerPoint (ppt)
test/          Tests de la logique de régie et du mapping (npm test)
```

NDI® est une marque déposée de Vizrt NDI AB.
