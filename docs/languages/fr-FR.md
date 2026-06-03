<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white" alt="Node version">
  <img src="https://img.shields.io/badge/version-2.15.3-8250df" alt="Version">
  <img src="https://img.shields.io/badge/cli-qq-4FC08D?logo=gnubash&logoColor=white" alt="CLI">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/provider-Groq-FF6C2C?logo=groq&logoColor=white" alt="Groq">
  <img src="https://img.shields.io/badge/model-Llama%203.1%2F3.3-8250df" alt="Llama 3.1/3.3">
</p>

# NeuroCommit

**Générateur de messages de commit Conventional Commits propulsé par l'IA** — analyse votre diff stagé et produit des messages de commit clairs et standardisés via [Groq](https://console.groq.com) (basé sur Meta Llama 3.1/3.3). Fonctionne comme hook Git, CLI interactive ou générateur autonome.

<p align="center">
  <a href="https://github.com/rxgodev/ac-cli#readme"><b>Documentation</b></a>
  ·
  <a href="https://github.com/rxgodev/ac-cli/issues"><b>Signaler un bug</b></a>
  ·
  <a href="https://github.com/rxgodev/neuro-commit/blob/main/README.md">English</a>
</p>

---

## Table des matières

- [Fonctionnalités](#fonctionnalités)
- [Installation](#installation)
- [Démarrage rapide](#démarrage-rapide)
- [Commandes](#commandes)
- [Configuration](#configuration)
- [Licence](#licence)

---

## Fonctionnalités

- **Messages de commit générés par IA** — un sujet en anglais au format Conventional Commits et un corps en français expliquant le *pourquoi*, dérivé de votre diff stagé.
- **Auto-incrémentation de version (optionnelle)** — détecte intelligemment les manifests de version dans tout le dépôt (compatible monorepo). Prend en charge 15+ formats :
  - `package.json`, `composer.json` — analyseur JSON
  - `Cargo.toml`, `pyproject.toml` — analyseur TOML
  - `pubspec.yaml`, `Chart.yaml`, `*.gemspec`, `setup.cfg`
  - `build.gradle`, `*.csproj`, `VERSION`, `version.txt`
  - Détection automatique par nom de fichier ; aucune configuration requise.
  - `feat:` → incrémentation **mineure**, `!` / `BREAKING CHANGE` → **majeure**, tout le reste → **corrective**
  - Préserver les préversions — conserve les suffixes `-alpha.1`, `+build`.
  - Fusion sûr — lit les manifests déjà stagés depuis l'index.
  - Sensible aux changements — ignore l'incrémentation si les fichiers modifiés ne concernent pas le package.
  - Sensible aux tags Git — utilise le dernier tag semver si aucun manifest ne contient de version.
- **Modification avant commit** — `qq go` permet de consulter, régénérer ou ouvrir `$EDITOR` pour ajuster le message avant de pousser.
- **Multi-projets** — gérez les hooks et les modèles `prepare-commit-msg` partagés pour plusieurs dépôts depuis un seul endroit.
- **Liste d'exclusion** — `.commitignore` fonctionne comme `.gitignore` ; les fichiers correspondants sont exclus du diff envoyé au modèle.

---

## Installation

### Prérequis

- **Node.js** >= 22
- Une **clé API gratuite** depuis [console.groq.com](https://console.groq.com)

### 1. Configurer GitHub Package Registry

```bash
pnpm login --scope=@rxgodev --registry=https://npm.pkg.github.com/
```

Saisissez votre nom d'utilisateur GitHub et un [jeton d'accès personnel](https://github.com/settings/tokens) avec les droits `write:packages` (le jeton va dans le champ "Password").

### 2. Installer globalement

```bash
pnpm add -g @rxgodev/neuro-commit@latest
```

### 3. Configurer votre clé API

```bash
qq config
```

Naviguez jusqu'à **API key** dans le menu et collez votre clé Groq.

---

## Démarrage rapide

```bash
# Installez le hook AI dans le dépôt courant
qq init

# Staguez les fichiers et committez — le message est généré automatiquement
git add .
git commit

# Ou utilisez le flux guidé complet
qq go
```

La commande `qq go` vous guide à travers : stage → commit → review → push. Après la génération du message, vous pouvez :

- **Push** — accepter et pousser immédiatement
- **Edit message** — ouvrir `$EDITOR` et modifier
- **Regenerate** — demander une nouvelle suggestion au modèle
- **Cancel** — reset logiciel et annuler

---

## Commandes

| Commande        | Description |
|-----------------|-------------|
| `qq init`       | Installer le hook AI dans le dépôt courant |
| `qq go`         | Flux guidé : stage → commit → review → push |
| `qq config`     | Configurer clé API, modèle, co-auteur, auto-incrémentation, projets et modèles |
| `qq status`     | Afficher l'état d'intégration du dépôt courant |
| `qq uninstall`  | Supprimer le hook du dépôt |

---

## Configuration

```bash
qq config
```

### Paramètres

| Paramètre            | Description |
|----------------------|-------------|
| **Model**            | Choisir entre Llama 3.1 **8B** (plus rapide, ~560 t/s) et **70B** (plus intelligent, ~280 t/s) |
| **Custom prompt**    | Personnaliser le prompt système. Utilisez `{types}` comme placeholder — il sera remplacé par la liste des types autorisés (feat, fix, chore, docs, style, refactor, perf, test, build, ci, revert plus vos types personnalisés) |
| **Custom types**     | Ajouter des types Conventional Commits supplémentaires (ex. `hotfix, deps, i18n, ui, api, db`) |
| **API key**          | Définir ou effacer votre clé API Groq |
| **Co-author**        | Activer/désactiver le `Co-authored-by` dans les messages de commit |
| **Auto-bump**        | Activer/désactiver l'incrémentation automatique de version pour 15+ types de manifests (désactivé par défaut) |
| **Projects & Templates** | Lister les projets intégrés et gérer les modèles `prepare-commit-msg` partagés |

### .commitignore

Modifiez `.commitignore` (syntaxe identique à `.gitignore`) pour exclure des fichiers du diff envoyé au modèle. Par défaut, les entrées liées à `.githooks` y sont listées.

---

## Licence

**MIT** — voir [LICENSE](./LICENSE).
