<template>
  <div>
    <div>
      <div class="text warning" v-show="!isEncrypted || !defaultEncryption">
        {{ i18n.dropbox_risk }}
      </div>
      <div v-show="backupToken">
        <div style="margin: 10px 0px 0px 20px; overflow-wrap: break-word">
          {{ i18n.account }} - {{ email }}
        </div>
      </div>
      <a-select-input
        v-show="!!defaultEncryption && backupToken"
        :label="i18n.encrypted"
        v-model="isEncrypted"
      >
        <option value="true">{{ i18n.yes }}</option>
        <option value="false">{{ i18n.no }}</option>
      </a-select-input>
      <a-button v-show="backupToken" @click="backupLogout()">
        {{ i18n.log_out }}
      </a-button>
      <a-button v-show="!backupToken" @click="getBackupToken()">
        {{ i18n.sign_in }}
      </a-button>
      <a-button v-show="!backupToken" @click="getBackupToken(true)">
        {{ i18n.sign_in_business }}
      </a-button>
      <div class="text" v-show="!backupToken">
        <a
          v-on:click="openLink('https://otp.ee/onedriveperms')"
          href="https://otp.ee/onedriveperms"
          >{{ i18n.onedrive_business_perms }}</a
        >
      </div>
      <a-button v-show="backupToken" @click="backupUpload()">
        {{ i18n.manual_dropbox }}
      </a-button>
    </div>
  </div>
</template>
<script lang="ts">
import Vue from "vue";
import { OneDrive, getBackupEncryption } from "../../models/backup";
import { UserSettings } from "../../models/settings";

const service = "onedrive";

export default Vue.extend({
  data: function () {
    return {
      email: this.i18n.loading,
    };
  },
  created() {
    UserSettings.updateItems();
  },
  computed: {
    defaultEncryption: function () {
      return this.$store.state.accounts.defaultEncryption;
    },
    isEncrypted: {
      get(): boolean {
        if (UserSettings.items.oneDriveEncrypted === null) {
          this.$store.commit("backup/setEnc", { service, value: true });
          UserSettings.items.oneDriveEncrypted = true;
          UserSettings.commitItems();
          return true;
        }
        return this.$store.state.backup.oneDriveEncrypted;
      },
      set(newValue: string) {
        UserSettings.items.oneDriveEncrypted = newValue === "true";
        UserSettings.commitItems();
        this.$store.commit("backup/setEnc", {
          service,
          value: newValue === "true",
        });
      },
    },
    backupToken: function () {
      return this.$store.state.backup.oneDriveToken;
    },
  },
  watch: {
    backupToken: async function (signedIn: boolean) {
      if (signedIn) {
        this.email = await this.getUser();
      }
    },
  },
  methods: {
    openLink(url: string) {
      window.open(url, "_blank");
      return;
    },
    async getBackupToken(business?: boolean) {
      // The background script reads this to pick the scope, so it has to be
      // stored before asking it to sign in.
      UserSettings.items.oneDriveBusiness = Boolean(business);
      await UserSettings.commitItems();
      chrome.runtime.sendMessage({ action: service });
    },
    async backupLogout() {
      UserSettings.items.oneDriveToken = undefined;
      UserSettings.items.oneDriveRefreshToken = undefined;
      await UserSettings.commitItems();
      this.$store.commit("backup/setToken", { service, value: false });
      this.$store.commit("style/hideInfo");
    },
    async backupUpload() {
      let response = false;
      try {
        response = await new OneDrive().upload(
          getBackupEncryption(this.$store.state.accounts)
        );
      } catch (error) {
        console.error(error);
      }
      await UserSettings.updateItems();
      if (response === true) {
        this.$store.commit("notification/alert", this.i18n.updateSuccess);
      } else if (UserSettings.items.oneDriveRevoked === true) {
        this.$store.commit(
          "notification/alert",
          chrome.i18n.getMessage("token_revoked", ["OneDrive"])
        );
        UserSettings.removeItem("oneDriveRevoked");
        this.$store.commit("backup/setToken", { service, value: false });
      } else {
        this.$store.commit("notification/alert", this.i18n.updateFailure);
      }
    },
    async getUser() {
      const oneDrive = new OneDrive();
      return await oneDrive.getUser();
    },
  },
  mounted: async function () {
    if (this.backupToken) {
      this.email = await this.getUser();
    }
  },
});
</script>
