# Téléprompteur

Application web pour se filmer en lisant son texte.
**Le texte défile à l'écran, mais n'apparaît pas dans la vidéo exportée.**

## Fonctionnement

- L'aperçu caméra est affiché en plein écran, au format choisi (9:16 vertical ou 16:9 horizontal).
- Le texte défile par-dessus, en haut de l'écran, près de l'objectif.
- L'enregistrement est fait à partir d'un `<canvas>` sur lequel seule l'image de la caméra est dessinée, plus le son du micro. Le texte n'est jamais dans la vidéo.
- Export en MP4 quand le navigateur le permet (c'est le cas de Safari sur iPhone).

## Utilisation sur iPhone

1. Ouvrir l'adresse de l'application dans **Safari** (HTTPS obligatoire pour la caméra).
2. Partager › **Sur l'écran d'accueil** pour l'avoir comme une app.
3. Autoriser la caméra et le micro.
4. « Texte & réglages » : coller le script, régler la vitesse, la taille du texte, etc.
5. Bouton rouge : compte à rebours, puis enregistrement et défilement.
   - Toucher le texte : pause / reprise du défilement.
   - Glisser sur le texte : avancer / reculer.
   - « − / + » : vitesse.
6. Bouton stop, puis « Enregistrer / Partager » › **Enregistrer la vidéo** pour l'ajouter à Photos.

Pour le 16:9, tourner le téléphone à l'horizontale : sinon l'image est recadrée dans une image verticale et perd en définition.

## Fichiers

- `index.html` : structure de la page
- `style.css` : mise en forme
- `app.js` : caméra, défilement, enregistrement
- `manifest.webmanifest`, `icon-*.png` : installation sur l'écran d'accueil

Aucune dépendance et aucune étape de compilation : il suffit d'héberger les fichiers en HTTPS (par exemple avec GitHub Pages).
