import axios from 'axios';
import { io } from 'socket.io-client';

// Finny simulator backend on localhost
const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8000';

export const api = axios.create({
    baseURL: API_URL
});

export const socket = io(API_URL, {
    transports: ['polling', 'websocket'],
    reconnection: true,
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});
