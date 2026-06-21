package com.academicagent.platform.identity.repository;

import java.util.List;
import java.util.Optional;

import com.academicagent.platform.identity.entity.SearchSetting;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SearchSettingRepository extends JpaRepository<SearchSetting, String> {

    List<SearchSetting> findByUserId(String userId);

    Optional<SearchSetting> findByUserIdAndSource(String userId, String source);
}
