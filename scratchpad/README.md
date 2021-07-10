This is the TypeScript starter project of Rakkas.

```sh
# Start development server on localhost:3000
npm run dev --host=localhost --port=3000

# Build for production
npm run build

# Start production server on 0.0.0.0:3000
HOST=0.0.0.0. PORT=3000 npm start
```

The most important files and directories are:

| Path               | Description                                   |
| ------------------ | --------------------------------------------- |
| `rakkas.config.ts` | Rakkas configuration                          |
| `public`           | Static files to be served from `/`            |
| `src/client.ts`    | Client-side cusomization hooks                |
| `src/server.ts`    | Server-side customization hooks               |
| `src/pages`        | Pages and layouts (client-side routes)        |
| `src/api`          | Endpoints and middleware (server-side routes) |