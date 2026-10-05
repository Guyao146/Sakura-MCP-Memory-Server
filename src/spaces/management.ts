import type { Database } from '../database.js';
import { requireSpaceRole } from '../memory/permissions.js';
import type { SpaceRole } from '../memory/types.js';

export class MemberManagement {
  constructor(private readonly database: Database) {}
  async list(userId: string,spaceId: string,page=1) {
    await requireSpaceRole(this.database,userId,spaceId,'viewer');
    const result=await this.database.query(`SELECT u.id,u.display_name,u.email,sm.role,count(*) OVER()::text AS total
      FROM space_members sm JOIN users u ON u.id=sm.user_id WHERE sm.space_id=$1 ORDER BY sm.created_at,u.id LIMIT 50 OFFSET $2`,[spaceId,(page-1)*50]);
    return {members:result.rows,page};
  }
  async invitations(userId: string,spaceId: string) {
    await requireSpaceRole(this.database,userId,spaceId,'admin');
    const rows=await this.database.query(`SELECT id,email,role,expires_at,accepted_at,revoked_at FROM space_invitations WHERE space_id=$1 ORDER BY created_at DESC LIMIT 100`,[spaceId]);
    return {invitations:rows.rows};
  }
  async revoke(userId: string,spaceId: string,id: string) {
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM spaces WHERE id=$1 AND deleted_at IS NULL FOR NO KEY UPDATE',[spaceId]);
      const member=await client.query('SELECT role FROM space_members WHERE space_id=$1 AND user_id=$2',[spaceId,userId]);
      if(!['owner','admin'].includes(member.rows[0]?.role))throw new Error('Space access denied.');
      const result=await client.query(`UPDATE space_invitations SET revoked_at=now() WHERE id=$1 AND space_id=$2 AND accepted_at IS NULL RETURNING id`,[id,spaceId]);
      if(!result.rows.length)throw new Error('Pending invitation not found.');
      await client.query('COMMIT');return {revoked:true};
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async change(userId: string,spaceId: string,target: string,role: SpaceRole|'remove'|'transfer') {
    const client=await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const space=await client.query(`SELECT type FROM spaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,[spaceId]);
      if(!space.rows[0]||space.rows[0].type==='personal') throw new Error('Only shared spaces support membership changes.');
      const members=await client.query<{user_id:string;role:SpaceRole}>('SELECT user_id,role FROM space_members WHERE space_id=$1 FOR UPDATE',[spaceId]);
      const actor=members.rows.find(x=>x.user_id===userId),other=members.rows.find(x=>x.user_id===target);
      if(!actor||!['owner','admin'].includes(actor.role)||!other) throw new Error('Membership access denied.');
      if(role==='owner') throw new Error('Use ownership transfer.');
      if(role==='transfer') {
        if(actor.role!=='owner'||userId===target) throw new Error('Only an owner can transfer to another member.');
        await client.query(`UPDATE space_members SET role='owner' WHERE space_id=$1 AND user_id=$2`,[spaceId,target]);
        await client.query(`UPDATE space_members SET role='admin' WHERE space_id=$1 AND user_id=$2`,[spaceId,userId]);
      } else {
        if(other.role==='owner'&&members.rows.filter(x=>x.role==='owner').length===1) throw new Error('Cannot remove or demote the last owner.');
        if(actor.role!=='owner'&&(other.role==='owner'||other.role==='admin'||role==='admin')) throw new Error('Only owners may manage administrators.');
        // Pending invitations from a changed member must not resurrect old privileges.
        await client.query('UPDATE space_invitations SET revoked_at=now() WHERE space_id=$1 AND invited_by=$2 AND accepted_at IS NULL',[spaceId,target]);
        if(role==='remove') {
          await client.query('DELETE FROM agent_space_grants g USING agent_credentials a WHERE g.agent_id=a.id AND a.owner_id=$1 AND g.space_id=$2',[target,spaceId]);
          const removed=await client.query<{email:string|null}>('SELECT email FROM users WHERE id=$1',[target]);
          if(removed.rows[0]?.email)await client.query('UPDATE space_invitations SET revoked_at=now() WHERE space_id=$1 AND lower(email)=lower($2) AND accepted_at IS NULL',[spaceId,removed.rows[0].email]);
          await client.query('DELETE FROM space_members WHERE space_id=$1 AND user_id=$2',[spaceId,target]);
        } else await client.query('UPDATE space_members SET role=$3 WHERE space_id=$1 AND user_id=$2',[spaceId,target,role]);
      }
      await client.query('COMMIT'); return {updated:true};
    } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
}
