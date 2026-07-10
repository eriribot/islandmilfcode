import type { Configuration } from 'webpack';

declare const process: { cwd: () => string };

const previewDir = `${process.cwd()}/src/islandmilfcode/gamedevelop-preview`;

const config: Configuration = {
  name: 'islandmilfcode-gamedevelop-preview',
  target: 'web',
  devtool: 'source-map',
  entry: `${previewDir}/main.ts`,
  output: {
    path: `${previewDir}/dist`,
    filename: 'app.js',
    clean: true,
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          transpileOnly: false,
          onlyCompileBundledFiles: true,
          compilerOptions: {
            noUnusedLocals: true,
            noUnusedParameters: true,
          },
        },
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  optimization: {
    minimize: false,
  },
};

export default config;
