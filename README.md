# ConeFlip  - README

## Introduction

Coneflip is a Twitch overlay game created for Twitch streamer [a "QUE" ismissing](https://www.twitch.tv/aquaismissing)

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) installed (v14 or higher recommended)
- [npm](https://www.npmjs.com/) installed
- Basic understanding of running Node.js applications

---

### Steps to Install

1. **Clone the Repository**:
   ```bash
   git clone <https://github.com/drippycatcs/aqua-coneflip>
2. **Install Dependencies**:
    ```bash
    npm install
2. **Run**:
    ```bash
    start.bat



Access the Application
Open your browser and navigate to http://localhost:3000




# API Endpoints

## GET `/`
Serves the main game interface.

---

## GET `/skins.json`
Returns the JSON file containing player skins.

---

## GET `/leaderboard.html`
Serves the leaderboard page.

---

## GET `/addcone`
Triggers a cone to appear for a specific player.  

**Query Parameters**:  
- `name` (string, required): The name of the player.  

**Example**:  
`/addcone?name=player1`

---

## GET `/api/leaderboard`
Returns the current leaderboard and the top player.  

**Response**:  
```json
{
  "leaderboard": [
    { "name": "player1", "wins": 10, "fails": 5, "winrate": "66.67" }
  ],
  "topPlayer": "player1"
}
```
```json
 _._     _,-'""`-._
(,-.`._,'(       |\`-/|
    `-.-' \ )-`( , o o)
          `-    \`_`"'- 
