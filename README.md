# FB Messages Archive Explorer

## Overview

FB Messages Archive Explorer is a web application designed to let you seamlessly browse and manage your entire Facebook Messenger data export. Built with React and Vite, it uses the modern File System Access API to read thousands of JSON files directly from your disk—without ever uploading your private data to a server.

This project is a powerful evolution of the original [DuckCIT/Facebook-Messenger-JSON-Viewer](https://github.com/DuckCIT/Facebook-Messenger-JSON-Viewer) and [serogee/Simple-Messenger-JSON-Explorer](https://github.com/serogee/Simple-Messenger-JSON-Explorer), transformed from a simple single-chat viewer into a full archive management tool.

## Features

- **Full Archive Loading.** Simply pick your extracted `messages` folder, and the app will organize and load all your inbox, archived threads, message requests, and end-to-end encrypted chats into a familiar sidebar.
- **Global Search.** Search across thousands of conversation names in your archive.
- **Messenger-like Chat Interface.** Read your JSON data just like the real Messenger app with sticky date headers, reaction displays, etc.
- **Complete Media Support.** Automatically resolves and displays images, videos, GIFs, and audio files attached in your chats.
- **Date Navigation.** Easily scrub through years of chat history with an interactive timeline.
- **Chat Analytics & Info Panel.** View detailed metrics for each conversation including message counts, participant activity bars, and total attachments.
- **Archive Management.** Given write access, you can delete unwanted conversations directly from the app to clean up your export and save disk space.
- **100% Local.** Everything runs client-side in your browser. Your data never leaves your computer.

## Usage

1. **Export Your Data**. Request a download of your Facebook information from Facebook's settings. Make sure to choose **JSON** format (HTML is not supported) and select high media quality if you want your photos and videos.
2. **Extract the Archive**. Unzip the downloaded file(s) to a folder on your computer.
3. **Open the Explorer**. Start the local development server (or open the hosted app).
4. **Load Your Messages**. 
   - Click the "Open Folder" button in the sidebar.
   - Select the `messages` folder inside your extracted Facebook data (can also select the parent folder to make it easier).
   - For deleting capabilities, check the "Request write access" box before selecting your folder.
5. **Browse**. Your chats will be categorized on the left. Click any chat to view it, search for specific people, and explore your history!

## Development

This project is built with Vite, React, and TypeScript.

### Getting Started

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information. This project builds upon the foundations of [DuckCIT/Facebook-Messenger-JSON-Viewer](https://github.com/DuckCIT/Facebook-Messenger-JSON-Viewer).

## Contact

For questions, feedback, or issues, please visit the repository at [serogee/FB-Messages-Archive-Explorer](https://github.com/serogee/FB-Messages-Archive-Explorer).
