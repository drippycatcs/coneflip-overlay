

![preview](https://i.imgur.com/uU6fn2C.gif)

## Introduction

Coneflip is a Twitch overlay game designed to add fun interactivity to your stream. Originally created for the Twitch streamer [aquaismissing](https://www.twitch.tv/aquaismissing) by [DrippyCatCS](https://x.com/drippycatcs) and [Aquaismissing](https://x.com/aquaismissing), Coneflip now leverages Twitch API endpoints to power its interactive features. The primary interfaces are the cone gameplay window and the leaderboard view, which are integrated into your streaming setup via OBS.

Contributions are welcome! Feel free to submit a pull request with enhancements or bug fixes!

---

## Features

- **Real-Time Leaderboard:** Watch player stats update live as the game progresses.
- **Custom Skins:** Players can add and equip custom skins for their cones.
- **OBS Integration:** Easily display the cone gameplay and leaderboard views in your stream.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- [npm](https://www.npmjs.com/)
- OBS or any streaming software that supports browser sources

---

## Installation

### 1. Clone the Repository

```bash
git clone https://github.com/drippycatcs/coneflip-overlay.git
```

### 2. Install Dependencies

Navigate into the project directory and install the required packages:

```bash
cd coneflip-overlay
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the root directory with the following variables:

```ini
PORT=3000
TWITCH_CLIENT_ID=your_twitch_client_id
STREAMER_ACCESS_TOKEN=your_streamer_or_bot_access_token
BOT_ACCESS_TOKEN=your_streamer_or_bot_access_token
TWITCH_DUEL_REWARD=duel_reward_id
TWITCH_CONE_REWARD=cone_reward_id
TWITCH_UNBOX_CONE=unbox_cone_reward_id
TWITCH_BUY_CONE=buy_cone_reward_id
BOT_NAME=your_bot_username
TWITCH_CHANNEL=your_channel_name
SEVENTV_TOKEN=your_7tv_token
CONE_ADMIN=admin1,admin2
```

> **Note:** The streamer token and bot token may be the same, provided they have the correct scopes. You can generate tokens with the required scopes using [Twitch Token Generator](https://twitchtokengenerator.com) with these scopes:  
> `chat:read chat:edit channel:read:subscriptions channel:read:redemptions user:read:subscriptions user:read:chat user:write:chat`


> **Note:** You can find your 7TV Token by doing  
> `inspect element -> application -> local storage -> https://7tv.io/ -> 7tv-auth-token`

> While logged in to 7TV.

### 4. Run the Application

Start the server with:

```bash
node app.js
```

The server will listen on the port specified (default is 3000).

---

## OBS Setup

### Cone Gameplay Window

1. **Add a Browser Source** in OBS.
2. Set the URL to: `http://localhost:3000/`
3. Configure the source as follows:
   - **Width:** 1920
   - **Height:** 1080
   - **Custom FPS:** 60 (if needed)
   - **CSS:** 
     ```css
     body { background-color: rgba(0, 0, 0, 0); margin: 0; overflow: hidden; }
     ```
   - Enable **Shutdown source when not visible** and **Refresh browser when scene becomes active**.

### Leaderboard Window

1. **Add another Browser Source** in OBS.
2. Set the URL to: `http://localhost:3000/leaderboard`
3. Use the same settings as the gameplay window (dimensions, FPS, CSS, etc.).

---

## API Endpoints

For OBS integration, only the following endpoints are exposed:

- **Cone Gameplay Window:**  
  **GET** `/`  
  *Serves the main cone gameplay view.*

- **Leaderboard View:**  
  **GET** `/leaderboard`  
  *Serves the live leaderboard view.*

---

## Adding and Managing Skins

### Adding a New Skin

> **Note**
> You can find a list to all included skins [here](https://drippycatcs.github.io/coneflip-overlay/commands#-cone-skins).

1. **Add the Skin Image:**  
   Place your skin image into the `public/skins/` directory.

2. **Update the Configuration:**  
   Edit the `public/skins/config.json` file to add a new skin entry. For example:

    ```json
    {
      "name": "your_skin_name",
      "visuals": "your_skin_image_filename",
      "canUnbox": true,
      "unboxWeight": 0
    }
    ```

   - Set `"canUnbox"` to `false` if you do not want the skin to be unboxable.
   - To add a “HOLO” texture, prefix the image filename with `holo_`.

---

## Contributing

Contributions are highly appreciated! When submitting a pull request, please include:
- A clear description of your changes.
- Any necessary tests or documentation updates.
- Adherence to the existing code style and structure.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Acknowledgments

Thanks to the Twitch community and all contributors for inspiring and improving Coneflip.

Thanks to Aquaismissing for valuable feedback and support.

Thanks to the 7TV Staff for providing insight and token to their api.

Happy Streaming! 🎉
