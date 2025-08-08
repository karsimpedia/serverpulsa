
import express  from "express"
const routerTopup = express.Router();

import { topup } from "../controllers/topup";
 routerTopup.post("/",  topup);

export default  routerTopup
