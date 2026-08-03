import express from "express";
import multer from "multer";
import { train } from "../controllers/train.controller.js";

const router = express.Router();

const upload = multer({ dest: "uploads/" });

router.post("/", upload.single("file"), train);

export default router;