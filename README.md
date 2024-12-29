# Coneflip Twitch Game  - README
![preview](https://i.imgur.com/9m5Gc7i.gif)
## Introduction

Coneflip is a Twitch overlay game created for Twitch streamer [aquaismissing](https://www.twitch.tv/aquaismissing)

Created by:

 [DrippyCatCS](https://x.com/suikerstuiker)  

 [Aquaismissing](https://x.com/aquaismissing)


Feel free to make a  [pull request](https://github.com/drippycatcs/coneflip-overlay/pulls
) and get your name added! 

*Be clear about what you added or changed, how it should work, and try to implement it in existing classes or functions while following clean coding practices.*

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) installed (v14 or higher recommended)
- [npm](https://www.npmjs.com/) installed
- Basic understanding of running Node.js applications
- OBS installed or any other streaming application supporting browser windows.
-  Any Twitch integration software that can make local requests installed.


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
2. **Enable game in OBS**:
     
    1:  Create the gameplay window 
  ![Image](https://i.imgur.com/2v8ZUpo.png)

        
      
        
        
        | Cone Window | 
        | -------- |
        | URL: http://localhost:3000/   |
        | Width: 1920   | 
        | Height: 1080    | 
        | Custom framerate: ☑| 
        | FPS: 60 | 
        | CSS: body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; } | 
        | Shutdown source when not visible : ☑| 
        | Refresh browser when scene becomes active : ☑| 
        

    2:  Create the leaderboard window 
  ![Image](https://i.imgur.com/27S6Yvr.png)

        
        | Leaderboard Window | 
        | -------- |
        | URL: http://localhost:3000/leaderboard   |
        | Width: 1920   | 
        | Height: 1080    | 
        | Custom framerate: ☑| 
        | FPS: 60 | 
        | CSS: body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; } | 
        | Shutdown source when not visible : ☑| 
        | Refresh browser when scene becomes active : ☑| 
        


  5. Create steam reward endpoint connections:
      	*⚠ With local Twitch integration software*
        ## Add Cone
        http://localhost:3000/api/cones/add?name=%username%

        ---

        ## Display Leaderboard
        http://localhost:3000/api/leaderboard?show=true

        ---

        ##  Apply Random Skin
        http://localhost:3000/api/skins/set?name=%username%&random=true

        ---

        ##  Apply Specific Skin
        http://localhost:3000/api/skins/set?name=%username%&skin=fade
        
        *(see skin list below)*

        ---
  
  7. Enjoy!
    
    







   ---
# API Endpoints 


## GET `/api/skins/users`
Returns the JSON file containing all player assigned skins.

---

## GET `/api/skins/odds`
Returns all odds of each skin.

---

## GET `/api/leaderboard`
Returns the current leaderboard and the top player.  

**Response**:  
```json
[
    { "name": "player1", "wins": 10, "fails": 5, "winrate": "66.67" },
    { "name": "player2", "wins": 4, "fails": 8, "winrate": "33.33" }
	...
]
```



   ---
# How to add skins
  1. Put the skin image into the `public/skins/` directory.
  2. Add a new entry to the `public/skins/config.json` file:
  ```json
    {
        "name": "[YOUR SKIN NAME]",
        "visuals": "[YOUR SKIN IMAGE FILENAME]",
        "canUnbox": true,
        "unboxWeight": 0
    }
  ```
  3. Change the values accordingly.
      - If you don't want your skin being unboxed by viewers, set `canUnbox` value to `false` and remove the `unboxWeight` field.
      - When you want to add a "HOLO" texture prefix the filename with `holo_`.

  ---
# Built-in skins (list)

```json
{
    {
        "name": "default",
        "visuals": "cone_xmas.webp",
        "canUnbox": false
    },
    {
        "name": "gold",
        "visuals": "cone_gold.png",
        "canUnbox": false
    },
    {
        "name": "glorp",
        "visuals": "cone_glorp.png",
        "canUnbox": true,
        "unboxWeight": 40
    },
    {
        "name": "inverted",
        "visuals": "cone_inverted.png",
        "canUnbox": true,
        "unboxWeight": 40
    },
    {
        "name": "poorlydrawn",
        "visuals": "cone_poorlydrawn.png",
        "canUnbox": true,
        "unboxWeight": 40
    },
    {
        "name": "negative",
        "visuals": "cone_negative.png",
        "canUnbox": true,
        "unboxWeight": 20
    },
    {
        "name": "comic",
        "visuals": "cone_comic.png",
        "canUnbox": true,
        "unboxWeight": 20
    },
    {
        "name": "tigertooth",
        "visuals": "cone_tigertooth.png",
        "canUnbox": true,
        "unboxWeight": 10
    },
    {
        "name": "casehardened",
        "visuals": "cone_casehardened.png",
        "canUnbox": true,
        "unboxWeight": 10
    },
    {
        "name": "ahegao",
        "visuals": "cone_ahegao.png",
        "canUnbox": true,
        "unboxWeight": 3
    },
    {
        "name": "fade",
        "visuals": "cone_fade.png",
        "canUnbox": true,
        "unboxWeight": 3
    },
    {
        "name": "printstream",
        "visuals": "cone_printstream.png",
        "canUnbox": true,
        "unboxWeight": 3
    },
    {
        "name": "rainbow",
        "visuals": "cone_rainbow.webp",
        "canUnbox": true,
        "unboxWeight": 0.5
    },
    {
        "name": "darkmatter",
        "visuals": "holo_darkmatter.jpg",
        "canUnbox": true,
        "unboxWeight": 1
    }
,
    {
        "name": "iridescent",
        "visuals": "holo_iridescent.jpg",
        "canUnbox": true,
        "unboxWeight": 1
    }
}
```
