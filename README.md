# FB Messages Archive Explorer

Browse your Facebook Messenger archive JSON files locally in your browser. All your data stays on your computer.

[Open the App](https://serogee.github.io/FB-Messages-Archive-Explorer/)

## Demo

![Demo](public/demo.png)

## Features

- **Full Archive Loading**: Pick your `messages` folder to see all your chats in a sidebar.
- **Global Search**: Search across thousands of chat names in your archive.
- **Familiar Chat Interface**: Read your data like the Messenger app. It has date headers and reactions.
- **Complete Media Support**: The app finds and shows images, videos, GIFs, and audio files.
- **Date Navigation**: Move through years of chat history with a timeline.
- **Chat Analytics**: See message counts and total attachments for each chat.
- **Archive Management**: Delete chats you do not want to keep. This saves disk space.

## How to Export Your Facebook Messages

1. Go to [Download Your Information](https://accountscenter.facebook.com/info_and_permissions/dyi).
2. Click **Create export**.
3. Select the Facebook **profile** you want to export.
4. Select **Export to device**.
5. Click **Customize options**.
6. In **all tabs**, clear every category. Keep only **Messages** selected.
   > [!TIP]
   > Clear all categories except Messages. This makes the export smaller and faster.
7. Set the **date range** to the period you want.
8. Change the format to **JSON**.
   > [!IMPORTANT]
   > You **must** select JSON format. The app does not support HTML exports.
9. Click **Create export**. Wait for Facebook to prepare your file. This can take minutes to hours.
10. Download the `.zip` file when it is ready.
11. Extract the zip to a folder on your computer.

## How to Use the App

1. Open the app at [https://serogee.github.io/FB-Messages-Archive-Explorer/](https://serogee.github.io/FB-Messages-Archive-Explorer/).
2. Click **Open Folder** in the sidebar.
3. Select one of these:
   - The **whole extracted folder** (the app finds the messages automatically), or
   - The **`messages`** folder inside the extracted data.
4. Optional: check **Request write access** if you want to delete conversations from the export.
5. Browse your chats in the sidebar. Click any chat to read it.

## Development

The project uses Vite, React, and TypeScript.

To build the app:
1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```

## License

This project has an MIT License. Read the [LICENSE](file:///c:/Program%20Tools/FB-Messages-Archive-Explorer/LICENSE) file for more information. This project builds upon the work of [DuckCIT/Facebook-Messenger-JSON-Viewer](https://github.com/DuckCIT/Facebook-Messenger-JSON-Viewer).

## Contact

For questions or issues, go to [serogee/FB-Messages-Archive-Explorer](https://github.com/serogee/FB-Messages-Archive-Explorer).
