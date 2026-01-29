#!/usr/bin/env bun
/**
 * whatidid - Generate engineering impact reports from GitHub activity
 *
 * Entry point for the CLI application
 */

import { createProgram } from './cli';

const program = createProgram();
program.parse();
