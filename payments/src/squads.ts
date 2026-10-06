import {PublicKey} from "@solana/web3.js";
export type SquadsControlStatus={configured:false}|{configured:true;multisig:string;vault:string;executor:string;vaultIndex:number};
export function squadsControlStatus(env:NodeJS.ProcessEnv=process.env):SquadsControlStatus{
 if(env.AXIS_SQUADS_ENABLED!=="true")return {configured:false};
 const multisig=env.AXIS_SQUADS_MULTISIG;const vault=env.AXIS_SQUADS_VAULT;const executor=env.AXIS_SQUADS_EXECUTOR;const vaultIndex=Number(env.AXIS_SQUADS_VAULT_INDEX??"0");
 if(!multisig||!vault||!executor)throw new Error("AXIS_SQUADS_MULTISIG, AXIS_SQUADS_VAULT and AXIS_SQUADS_EXECUTOR are required");
 if(!Number.isInteger(vaultIndex)||vaultIndex<0||vaultIndex>255)throw new Error("AXIS_SQUADS_VAULT_INDEX must be an integer from 0 to 255");
 return {configured:true,multisig:new PublicKey(multisig).toBase58(),vault:new PublicKey(vault).toBase58(),executor:new PublicKey(executor).toBase58(),vaultIndex};
}
