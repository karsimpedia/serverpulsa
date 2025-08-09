
import express  from "express"
const routerTopup = express.Router();

import { createTopup } from "../controllers/topup.js";
 routerTopup.post("/",  createTopup);

export default  routerTopup
